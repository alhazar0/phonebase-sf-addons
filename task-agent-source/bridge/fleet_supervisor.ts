import "dotenv/config";

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type FleetBinding = {
  id: string;
  serial?: string;
  serialPrefix?: string;
  camera?: string;
  cameraIdentity?: string;
  captureSize?: string;
  captureFps?: number;
  cameraStreamPort?: number;
  profileId?: string;
  driverPort: number;
};

type FleetDevice = FleetBinding & { serial: string; camera: string };

type ManagedDevice = {
  config: FleetDevice;
  driver: ChildProcess;
  node: ChildProcess | null;
};

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG_PATH = resolve(
  process.env.SCREENHAND_FLEET_CONFIG ?? "config/device-fleet.json",
);
const CALIBRATION_DIRECTORY = resolve(
  process.env.SCREENHAND_CALIBRATION_DIRECTORY ?? "build/devices",
);
const CONTROL_PLANE_PORT = Number(
  process.env.SCREENHAND_CONTROL_PLANE_PORT ?? 3013,
);
const CAMERA_BROKER_BINARY = process.env.SCREENHAND_CAMERA_BROKER_BINARY?.trim() ?? "";
const CAMERA_BROKER_APP = process.env.SCREENHAND_CAMERA_BROKER_APP?.trim() ?? "";
const managed = new Map<string, ManagedDevice>();
let controlPlane: ChildProcess | null = null;
let cameraBroker: ChildProcess | null = null;
let stopped = false;

function safeDevice(value: unknown, index: number): FleetBinding {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const id = String(input.id ?? "").trim();
  const serial = String(input.serial ?? "").trim();
  const serialPrefix = String(input.serialPrefix ?? "").trim();
  const camera = String(input.camera ?? "").trim();
  const cameraIdentity = String(input.cameraIdentity ?? "").trim();
  const captureSize = String(input.captureSize ?? "").trim();
  const captureFps = Number(input.captureFps ?? 0);
  const cameraStreamPort = Number(input.cameraStreamPort ?? 0);
  const profileId = String(input.profileId ?? "").trim();
  const driverPort = Number(input.driverPort ?? 3014 + index);
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(id)) throw new Error(`Invalid device id at index ${index}`);
  if (!serial && !serialPrefix) throw new Error(`Serial identity is required for ${id}`);
  if (serial && !serial.startsWith("/dev/cu.")) throw new Error(`Invalid serial path for ${id}`);
  if (serialPrefix && !serialPrefix.startsWith("/dev/cu.usbserial-")) {
    throw new Error(`Invalid serial prefix for ${id}`);
  }
  if (!camera && !cameraIdentity) throw new Error(`Camera identity is required for ${id}`);
  if (captureSize && !new Set(["640x480", "1280x720", "1920x1080"]).has(captureSize)) {
    throw new Error(`Invalid camera capture size for ${id}`);
  }
  if (captureFps && !new Set([5, 15, 30]).has(captureFps)) {
    throw new Error(`Invalid camera capture frame rate for ${id}`);
  }
  if (
    cameraStreamPort &&
    (!Number.isInteger(cameraStreamPort) || cameraStreamPort < 3_000 || cameraStreamPort > 65_535)
  ) {
    throw new Error(`Invalid camera stream port for ${id}`);
  }
  if (!Number.isInteger(driverPort) || driverPort < 3014 || driverPort > 3999) {
    throw new Error(`Invalid driver port for ${id}`);
  }
  return {
    id,
    ...(serial ? { serial } : {}),
    ...(serialPrefix ? { serialPrefix } : {}),
    ...(camera ? { camera } : {}),
    ...(cameraIdentity ? { cameraIdentity } : {}),
    ...(captureSize ? { captureSize } : {}),
    ...(captureFps ? { captureFps } : {}),
    ...(cameraStreamPort ? { cameraStreamPort } : {}),
    ...(profileId ? { profileId } : {}),
    driverPort,
  };
}

function configuredDevices(): FleetBinding[] {
  if (!existsSync(CONFIG_PATH)) return [];
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { devices?: unknown[] };
  const devices = (parsed.devices ?? []).map(safeDevice);
  const ids = new Set<string>();
  const ports = new Set<number>();
  const cameraStreamPorts = new Set<number>();
  for (const device of devices) {
    if (ids.has(device.id)) throw new Error(`Duplicate device id: ${device.id}`);
    if (ports.has(device.driverPort)) throw new Error(`Duplicate driver port: ${device.driverPort}`);
    if (device.cameraStreamPort && cameraStreamPorts.has(device.cameraStreamPort)) {
      throw new Error(`Duplicate camera stream port: ${device.cameraStreamPort}`);
    }
    ids.add(device.id);
    ports.add(device.driverPort);
    if (device.cameraStreamPort) cameraStreamPorts.add(device.cameraStreamPort);
  }
  return devices;
}

function detectedSerials() {
  const result = spawnSync("zsh", ["-c", "print -rl -- /dev/cu.usbserial-*(N)"], {
    encoding: "utf8",
  });
  return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean).sort();
}

function detectedCameras() {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "",
  ], { encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  const videoSection = output.split("AVFoundation audio devices:")[0] ?? output;
  return [...videoSection.matchAll(/\[(\d+)\]\s+([^\r\n]+)/g)]
    .map((match) => ({ index: match[1], name: match[2].trim() }))
    .filter((camera) => /USB Camera/i.test(camera.name));
}

function detectedSystemCameras() {
  const source = [
    "import AVFoundation",
    "for (index, device) in AVCaptureDevice.devices(for: .video).enumerated() {",
    "  print(\"\\(index)\\t\\(device.localizedName)\\t\\(device.uniqueID)\")",
    "}",
  ].join("\n");
  const result = spawnSync("swift", ["-e", source], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\n").flatMap((line) => {
    const [index, name, uniqueId] = line.trim().split("\t");
    return /^\d+$/.test(index ?? "") && name && uniqueId
      ? [{ index, name, uniqueId }]
      : [];
  });
}

function resolveCameraAssignments(bindings: FleetBinding[]) {
  const assignments = new Map<string, string>();
  const systemCameras = detectedSystemCameras();
  const avCameras = detectedCameras();
  for (const binding of bindings) {
    if (binding.cameraIdentity) {
      const prefix = binding.cameraIdentity.toLowerCase();
      const matches = systemCameras.filter((camera) =>
        camera.uniqueId.toLowerCase().startsWith(prefix)
      );
      if (matches.length !== 1) {
        console.warn(
          `${binding.id} camera identity matched ${matches.length} devices; keeping it locked.`,
        );
        continue;
      }
      const identity = matches[0];
      const camera = avCameras.find((candidate) => candidate.index === identity.index);
      if (
        !camera ||
        camera.name !== identity.name ||
        !/^USB Camera2$/i.test(camera.name)
      ) {
        console.warn(`${binding.id} camera identity did not resolve to a robot USB camera.`);
        continue;
      }
      assignments.set(binding.id, camera.index);
      console.log(
        `Resolved ${binding.id} camera ${binding.cameraIdentity} -> AVFoundation ${camera.index}`,
      );
    } else if (binding.camera) {
      assignments.set(binding.id, binding.camera);
    }
  }
  return assignments;
}

function hardwareSignature() {
  const result = spawnSync("ioreg", ["-p", "IOUSB", "-w0"], { encoding: "utf8" });
  const cameraLocations = [...result.stdout.matchAll(/USB Camera2@([0-9a-f]+)/gi)]
    .map((match) => match[1].toLowerCase())
    .sort();
  return JSON.stringify({ serials: detectedSerials(), cameraLocations });
}

function bindingClaimsSerial(binding: FleetBinding, serial: string) {
  return binding.serial === serial || Boolean(
    binding.serialPrefix && serial.startsWith(binding.serialPrefix),
  );
}

function bindingClaimsCamera(binding: FleetBinding, uniqueId: string) {
  return Boolean(
    binding.cameraIdentity &&
    uniqueId.toLowerCase().startsWith(binding.cameraIdentity.toLowerCase()),
  );
}

function withSafelyDiscoveredDevice(bindings: FleetBinding[]) {
  const unclaimedSerials = detectedSerials().filter((serial) =>
    !bindings.some((binding) => bindingClaimsSerial(binding, serial))
  );
  const unclaimedCameras = detectedSystemCameras().filter((camera) =>
    /^USB Camera2$/i.test(camera.name) &&
    !bindings.some((binding) => bindingClaimsCamera(binding, camera.uniqueId))
  );
  if (!unclaimedSerials.length && !unclaimedCameras.length) return bindings;
  if (unclaimedSerials.length !== 1 || unclaimedCameras.length !== 1) {
    console.warn(
      `Unpaired discovery found ${unclaimedSerials.length} controller(s) and ` +
      `${unclaimedCameras.length} camera(s); keeping all ambiguous hardware locked.`,
    );
    return bindings;
  }

  const ids = new Set(bindings.map((binding) => binding.id));
  let ordinal = 1;
  while (ids.has(`black-arm-${String(ordinal).padStart(2, "0")}`)) ordinal += 1;
  const driverPorts = new Set(bindings.map((binding) => binding.driverPort));
  let driverPort = 3014;
  while (driverPorts.has(driverPort)) driverPort += 1;
  const streamPorts = new Set(
    bindings.flatMap((binding) => binding.cameraStreamPort ? [binding.cameraStreamPort] : []),
  );
  let cameraStreamPort = 3111;
  while (streamPorts.has(cameraStreamPort)) cameraStreamPort += 1;
  const discovered: FleetBinding = {
    id: `black-arm-${String(ordinal).padStart(2, "0")}`,
    serial: unclaimedSerials[0],
    cameraIdentity: unclaimedCameras[0].uniqueId,
    captureSize: "640x480",
    captureFps: 30,
    cameraStreamPort,
    profileId: "unconfigured",
    driverPort,
  };
  console.log(
    `Safely discovered ${discovered.id}: ${discovered.serial} + ` +
    `${discovered.cameraIdentity}; starting view-only setup mode.`,
  );
  return [...bindings, discovered];
}

function discoveredSingleDevice(): FleetDevice[] {
  const serials = detectedSerials();
  const cameras = detectedCameras();
  if (serials.length === 1 && cameras.length === 1) {
    return [{ id: "black-arm-01", serial: serials[0], camera: cameras[0].index, driverPort: 3014 }];
  }
  if (serials.length || cameras.length) {
    console.warn(
      `Detected ${serials.length} controller(s) and ${cameras.length} USB camera(s). ` +
      `Create ${CONFIG_PATH} once to bind each physical pair safely.`,
    );
  }
  return [];
}

function child(command: string, args: string[], environment: Record<string, string>) {
  return spawn(command, args, {
    cwd: ROOT,
    env: { ...globalThis.process.env, ...environment },
    stdio: "inherit",
  });
}

async function waitForDriver(port: number) {
  for (let attempt = 0; attempt < 50 && !stopped; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(300),
      });
      if (response.ok) return true;
    } catch {
      // The driver may still be negotiating its serial port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return false;
}

function nodeEnvironment(config: FleetDevice): Record<string, string> {
  return {
    SCREENHAND_BLACK_AUTO_HOME: "0",
    SCREENHAND_BLACK_DEVICE_ID: config.id,
    SCREENHAND_BLACK_DRIVER_URL: `http://127.0.0.1:${config.driverPort}`,
    SCREENHAND_BLACK_CAMERA: config.camera,
    ...(config.cameraIdentity
      ? { SCREENHAND_BLACK_CAMERA_IDENTITY: config.cameraIdentity }
      : {}),
    ...(config.cameraIdentity ? { SCREENHAND_BLACK_CAMERA_RESOLVED: "1" } : {}),
    ...(config.captureSize ? { SCREENHAND_BLACK_CAPTURE_SIZE: config.captureSize } : {}),
    ...(config.captureFps
      ? { SCREENHAND_BLACK_CAPTURE_FPS: String(config.captureFps) }
      : {}),
    ...(config.cameraStreamPort
      ? { SCREENHAND_BLACK_CAMERA_STREAM_PORT: String(config.cameraStreamPort) }
      : {}),
    ...(config.profileId ? { SCREENHAND_BLACK_PROFILE_ID: config.profileId } : {}),
  };
}

async function startDevice(config: FleetDevice) {
  if (managed.has(config.id) || !existsSync(config.serial)) return;
  console.log(
    `Connecting ${config.id}: ${config.serial} + camera ${config.cameraIdentity ?? config.camera}`,
  );
  const driver = child("python3", ["bridge/black_arm_driver.py"], {
    SCREENHAND_BLACK_SERIAL: config.serial,
    SCREENHAND_BLACK_PORT: String(config.driverPort),
  });
  const entry: ManagedDevice = { config, driver, node: null };
  managed.set(config.id, entry);
  driver.once("exit", () => {
    entry.node?.kill("SIGTERM");
    managed.delete(config.id);
  });
  if (!await waitForDriver(config.driverPort) || stopped) {
    driver.kill("SIGTERM");
    return;
  }
  entry.node = child("npm", ["run", "black:node"], nodeEnvironment(config));
  entry.node.once("exit", () => { entry.node = null; });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
}

function resolvedDevice(
  binding: FleetBinding,
  cameraAssignments: Map<string, string>,
): FleetDevice | null {
  const camera = cameraAssignments.get(binding.id);
  if (!camera) return null;
  if (binding.serial) {
    return existsSync(binding.serial) ? { ...binding, serial: binding.serial, camera } : null;
  }
  const matches = detectedSerials().filter((serial) => serial.startsWith(binding.serialPrefix!));
  if (matches.length !== 1) {
    if (matches.length > 1) {
      console.warn(`${binding.id} serial identity matched ${matches.length} devices; keeping it locked.`);
    }
    return null;
  }
  return { ...binding, serial: matches[0], camera };
}

function stopMissingDevices(devices: FleetDevice[]) {
  const resolved = new Map(devices.map((device) => [device.id, device]));
  for (const [id, entry] of managed) {
    const current = resolved.get(id);
    const sameCameraIdentity = current?.cameraIdentity
      ? current.cameraIdentity === entry.config.cameraIdentity
      : current?.camera === entry.config.camera;
    if (
      current?.serial === entry.config.serial &&
      sameCameraIdentity &&
      existsSync(current.serial)
    ) continue;
    // A camera-only disconnect must lock video/touch without throwing away the
    // controller's in-memory homing reference. Reconcile it when the same
    // unique camera returns; only a missing controller tears the device down.
    if (!current && existsSync(entry.config.serial)) continue;
    console.log(`${id} disconnected or USB identity changed`);
    entry.node?.kill("SIGTERM");
    entry.driver.kill("SIGTERM");
    managed.delete(id);
  }
}

async function reconcile(
  bindings: FleetBinding[],
  cameraAssignments: Map<string, string>,
) {
  const configs = bindings
    .map((binding) => resolvedDevice(binding, cameraAssignments))
    .filter((device): device is FleetDevice => device !== null);
  stopMissingDevices(configs);
  for (const config of configs) {
    const entry = managed.get(config.id);
    if (!entry) {
      await startDevice(config);
    } else if (!entry.node && existsSync(config.serial)) {
      // The native camera broker keeps its socket open for the lifetime of a
      // node connection. If that node is restarted, recycle only the broker so
      // it connects to the new listener; the homed driver remains untouched.
      if (config.cameraStreamPort && cameraBroker) {
        stopCameraBroker();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
      }
      entry.node = child("npm", ["run", "black:node"], nodeEnvironment(config));
      entry.node.once("exit", () => { entry.node = null; });
    }
  }
  return configs;
}

function stopCameraBroker() {
  const broker = cameraBroker;
  cameraBroker = null;
  if (!broker || broker.exitCode !== null) return;
  if (CAMERA_BROKER_APP) {
    // `open -W` is only the launcher/waiter. Terminate the executable inside
    // the exact configured bundle as well, regardless of its legacy name.
    spawnSync("/usr/bin/pkill", [
      "-TERM",
      "-f",
      `${CAMERA_BROKER_APP}/Contents/MacOS/`,
    ]);
  }
  broker.kill("SIGTERM");
  setTimeout(() => {
    if (broker.exitCode === null) broker.kill("SIGKILL");
  }, 500).unref();
}

function startCameraBroker(configs: FleetDevice[]) {
  if (cameraBroker && cameraBroker.exitCode === null) return;
  const cameras = configs.filter((config) =>
    config.cameraStreamPort && config.cameraIdentity && managed.get(config.id)?.node
  );
  if (!cameras.length) return;
  const bindingArgs: string[] = [];
  for (const config of cameras) {
    const [width, height] = (config.captureSize ?? "640x480").split("x");
    bindingArgs.push(
      "--camera", config.cameraIdentity!,
      "--port", String(config.cameraStreamPort),
      "--width", width,
      "--height", height,
      "--fps", String(config.captureFps ?? 30),
    );
  }
  console.log(
    `Starting native unique-ID camera broker for ${cameras.map((camera) => camera.id).join(", ")}`,
  );
  const command = CAMERA_BROKER_APP
    ? "/usr/bin/open"
    : CAMERA_BROKER_BINARY || "swift";
  const args = CAMERA_BROKER_APP
    ? ["-n", "-W", CAMERA_BROKER_APP, "--args", ...bindingArgs]
    : CAMERA_BROKER_BINARY
      ? bindingArgs
      : [resolve(ROOT, "bridge/CameraBroker.swift"), ...bindingArgs];
  cameraBroker = child(command, args, {});
  cameraBroker.once("exit", (code) => {
    console.warn(`Shared camera broker stopped (${code ?? "signal"}).`);
    cameraBroker = null;
  });
}

function stopManagedDevices() {
  stopCameraBroker();
  for (const entry of managed.values()) {
    entry.node?.kill("SIGTERM");
    entry.driver.kill("SIGTERM");
  }
  managed.clear();
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  stopManagedDevices();
  controlPlane?.kill("SIGTERM");
  setTimeout(() => globalThis.process.exit(0), 500).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  globalThis.process.on(signal, shutdown);
}

if (process.env.SCREENHAND_FLEET_START_CONTROL_PLANE !== "0") {
  controlPlane = child("npm", ["run", "control-plane"], {
    SCREENHAND_CONTROL_PLANE_PORT: String(CONTROL_PLANE_PORT),
    SCREENHAND_CALIBRATION_DIRECTORY: CALIBRATION_DIRECTORY,
    SCREENHAND_CALIBRATION_PATH: resolve(ROOT, "build/black-arm-calibration.json"),
  });
}

const configured = configuredDevices();
const baseDevices = configured.length ? configured : discoveredSingleDevice();
let devices = configured.length ? withSafelyDiscoveredDevice(baseDevices) : baseDevices;
console.log(
  configured.length
    ? `Loaded ${configured.length} device binding(s) from ${CONFIG_PATH}`
    : "Using safe single-device discovery; no persistent fleet binding found.",
);
let cameraAssignments = resolveCameraAssignments(devices);
let lastHardwareSignature = hardwareSignature();
let reconcileActive = false;
startCameraBroker(await reconcile(devices, cameraAssignments));
setInterval(() => {
  if (stopped || reconcileActive) return;
  reconcileActive = true;
  void (async () => {
    const currentSignature = hardwareSignature();
    if (currentSignature !== lastHardwareSignature) {
      console.log("USB topology changed; locking streams and resolving physical identities again.");
      // Camera membership can change without restarting healthy controllers.
      // Restart only the shared camera broker; reconcile below stops only the
      // device whose serial controller actually disappeared.
      stopCameraBroker();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
      devices = configured.length ? withSafelyDiscoveredDevice(baseDevices) : baseDevices;
      cameraAssignments = resolveCameraAssignments(devices);
      lastHardwareSignature = hardwareSignature();
    }
    const configs = await reconcile(devices, cameraAssignments);
    startCameraBroker(configs);
  })().finally(() => { reconcileActive = false; });
}, 1_500);
