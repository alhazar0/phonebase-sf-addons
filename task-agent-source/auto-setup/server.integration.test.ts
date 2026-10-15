import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import type { ScreenHandCalibrationProfile } from "../agent/calibration-profile";

const profile: ScreenHandCalibrationProfile = {
  id: "mock-station-v1",
  deviceId: "mock-arm-01",
  verified: true,
  verifiedAt: "2026-08-28T00:00:00.000Z",
  frame: { width: 720, height: 1280 },
  screen: { width: 720, height: 1560 },
  imagePoints: [
    { x: 100, y: 80 },
    { x: 620, y: 80 },
    { x: 620, y: 1200 },
    { x: 100, y: 1200 },
  ],
  machinePoints: [
    { x: 70, y: 146 },
    { x: 14, y: 146 },
    { x: 14, y: 14 },
    { x: 70, y: 14 },
  ],
  safeMachineBounds: {
    minimumX: 15,
    maximumX: 69,
    minimumY: 15,
    maximumY: 145,
  },
  tap: { hoverZ: 1, touchZ: 10, zStep: 0.5, feed: 3000, dwellMs: 40 },
  placementCalibration: {
    method: "joint-camera-touch-v1",
    verifiedAt: "2026-08-28T00:00:00.000Z",
    cameraRmsePx: 1.8,
    cameraMaximumErrorPx: 2.7,
  },
};

function listen(server: Server) {
  return new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a local test port."));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function reservePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  return port;
}

async function waitForHealth(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Auto-setup test service exited with ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch {
      // Startup can include one native Swift compilation on a clean machine.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Auto-setup test service did not become healthy.");
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signalTree = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signalTree("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) signalTree("SIGKILL");
}

test("automatically establishes a stable camera reference without hardware actions", {
  skip: process.platform !== "darwin",
  timeout: 120_000,
}, async () => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "screenhand-auto-setup-test-"));
  let frame = await sharp({
    create: {
      width: 720,
      height: 1280,
      channels: 3,
      background: { r: 12, g: 18, b: 28 },
    },
  }).composite([{
    input: Buffer.from(`
      <svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg">
        <rect x="100" y="80" width="520" height="1120" rx="34" fill="#f4f7fb"/>
        <rect x="130" y="130" width="190" height="130" rx="18" fill="#ef5350"/>
        <rect x="400" y="130" width="190" height="130" rx="18" fill="#42a5f5"/>
        <circle cx="220" cy="430" r="82" fill="#66bb6a"/>
        <circle cx="500" cy="430" r="82" fill="#ab47bc"/>
        <path d="M150 650 L570 650 L500 1060 L220 1060 Z" fill="#ffca28"/>
        <text x="360" y="1160" text-anchor="middle" font-size="54" fill="#17202a">ScreenHand</text>
      </svg>
    `),
  }]).jpeg({ quality: 88 }).toBuffer();
  let actionRequests = 0;
  let profileWrites = 0;
  let frameSequence = 76;
  let activeProfile = profile;

  const mockControlPlane = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/api/v1/devices/mock-arm-01") {
      json({
        ok: true,
        device: {
          id: profile.deviceId,
          connected: true,
          capabilities: {
            observation: {
              screenshot: { available: true },
            },
          },
          state: {
            // A feature control plane may receive a verified physical-camera
            // frame through the fresh-frame relay while its command node has
            // no camera broker of its own.
            cameraReady: false,
            grbl: {
              connected: true,
              homed: true,
              state: "Idle",
              activeOperation: null,
              movementBounds: {
                minimumX: 5.8,
                maximumX: 78.5,
                minimumY: 10.5,
                maximumY: 168,
              },
            },
          },
          screen: { width: 720, height: 1560, rawWidth: 720, rawHeight: 1280 },
        },
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/devices/mock-arm-01/calibration"
    ) {
      json({ ok: true, calibration: { active: activeProfile } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/frame") {
      const requestedSequence = Number(url.searchParams.get("sequence"));
      const sequence = Number.isInteger(requestedSequence) && requestedSequence > 0
        ? requestedSequence
        : ++frameSequence;
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(frame.length),
        "X-ScreenHand-Frame-Sequence": String(sequence),
      });
      response.end(frame);
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/actions")) {
      actionRequests += 1;
      json({ ok: false, error: "The mock forbids actions." }, 500);
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/calibration")) {
      profileWrites += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          profile: ScreenHandCalibrationProfile;
        };
        activeProfile = payload.profile;
        json({ ok: true, calibration: { active: activeProfile } });
      });
      return;
    }
    json({ ok: false, error: "Not found" }, 404);
  });

  let child: ChildProcess | null = null;
  try {
    const controlPlanePort = await listen(mockControlPlane);
    const autoSetupPort = await reservePort();
    child = spawn(
      process.execPath,
      ["--import", "tsx", "auto-setup/server.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SCREENHAND_AUTO_SETUP_PORT: String(autoSetupPort),
          SCREENHAND_AUTO_SETUP_STATE_DIRECTORY: stateDirectory,
          SCREENHAND_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`,
        },
        stdio: "ignore",
        detached: process.platform !== "win32",
      },
    );
    const baseUrl = `http://127.0.0.1:${autoSetupPort}`;
    await waitForHealth(`${baseUrl}/health`, child);

    const firstPreview = await fetch(`${baseUrl}/v1/devices/mock-arm-01/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(firstPreview.status, 200);
    const baseline = await firstPreview.json() as {
      status: string;
      frame: { sequence: number };
      automaticBaseline: { frameCount: number; maximumDeviationPx: number };
    };
    assert.equal(baseline.status, "automatic_baseline_ready");
    assert.equal(baseline.automaticBaseline.frameCount, 3);
    assert.ok(baseline.automaticBaseline.maximumDeviationPx < 1);

    const dryRun = await fetch(`${baseUrl}/v1/devices/mock-arm-01/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(dryRun.status, 200);
    const dryResult = await dryRun.json() as {
      status: string;
      moved: boolean;
      profileUpdated: boolean;
      preview: { status: string };
    };
    assert.equal(dryResult.status, "previewed");
    assert.equal(dryResult.moved, false);
    assert.equal(dryResult.profileUpdated, false);
    assert.equal(dryResult.preview.status, "automatic_baseline_ready");
    assert.equal(actionRequests, 0);
    assert.equal(profileWrites, 0);
    const stationArtifactPath = resolve(
      stateDirectory,
      "mock-arm-01.station-plane.json",
    );
    await assert.rejects(
      readFile(stationArtifactPath),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    const automaticRun = await fetch(`${baseUrl}/v1/devices/mock-arm-01/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "CLEAR_WORKSPACE_AND_AUTO_SETUP" }),
    });
    assert.equal(automaticRun.status, 200);
    const result = await automaticRun.json() as {
      status: string;
      moved: boolean;
      profileUpdated: boolean;
      referenceCreated: boolean;
      preview: { status: string; registration: { confidence: number } };
    };
    assert.equal(result.status, "completed");
    assert.equal(result.moved, false);
    assert.equal(result.profileUpdated, true);
    assert.equal(result.referenceCreated, true);
    assert.equal(result.preview.status, "ready");
    assert.ok(result.preview.registration.confidence >= 0.78);
    assert.equal(actionRequests, 0);
    assert.equal(profileWrites, 2);

    const stationArtifact = JSON.parse(await readFile(
      stationArtifactPath,
      "utf8",
    )) as {
      calibration: { deviceId: string; evidence: { method: string } };
      sha256: string;
    };
    assert.equal(stationArtifact.calibration.deviceId, "mock-arm-01");
    assert.equal(
      stationArtifact.calibration.evidence.method,
      "joint-camera-touch-v1",
    );
    assert.match(stationArtifact.sha256, /^[a-f0-9]{64}$/);

    const savedReferenceFrame = frame;
    frame = await sharp({
      create: {
        width: 720,
        height: 1280,
        channels: 3,
        background: { r: 8, g: 11, b: 17 },
      },
    }).composite([{
      input: Buffer.from(`
        <svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg">
          <rect x="145" y="60" width="430" height="1160" rx="24" fill="#f3f6fa"/>
          <circle cx="360" cy="270" r="105" fill="#00a6a6"/>
          <path d="M205 540 H515 V740 H205 Z" fill="#ff8a3d"/>
          <path d="M210 900 L510 810 L500 1110 L220 1110 Z" fill="#3949ab"/>
          <path d="M35 430 L690 760 L650 900 L0 565 Z" fill="#080b11"/>
        </svg>
      `),
    }]).jpeg({ quality: 88 }).toBuffer();
    const unknownPreview = await fetch(
      `${baseUrl}/v1/devices/mock-arm-01/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unknownPreview.status, 200);
    const unknown = await unknownPreview.json() as {
      status: string;
      proposedImagePoints: unknown[];
      unknownPhoneCandidate: {
        xyReady: boolean;
        touchDepthReady: boolean;
        actionReady: boolean;
        blockers: string[];
        frame: { sequences: number[] };
      };
    };
    assert.equal(unknown.status, "unknown_phone_detected");
    assert.equal(unknown.proposedImagePoints.length, 4);
    assert.equal(unknown.unknownPhoneCandidate.xyReady, true);
    assert.equal(unknown.unknownPhoneCandidate.touchDepthReady, false);
    assert.equal(unknown.unknownPhoneCandidate.actionReady, false);
    assert.ok(unknown.unknownPhoneCandidate.blockers.includes("touch_depth_unverified"));
    assert.equal(unknown.unknownPhoneCandidate.frame.sequences.length, 3);
    assert.equal(actionRequests, 0);
    assert.equal(profileWrites, 2);

    const blockedRun = await fetch(`${baseUrl}/v1/devices/mock-arm-01/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(blockedRun.status, 409);
    const blocked = await blockedRun.json() as { code: string };
    assert.equal(blocked.code, "VISUAL_PREFLIGHT_FAILED");
    assert.equal(actionRequests, 0);
    assert.equal(profileWrites, 2);

    frame = await sharp({
      create: {
        width: 720,
        height: 1280,
        channels: 3,
        background: { r: 2, g: 1, b: 3 },
      },
    }).jpeg({ quality: 88 }).toBuffer();
    const blankPreview = await fetch(`${baseUrl}/v1/devices/mock-arm-01/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(blankPreview.status, 409);
    const blankResult = await blankPreview.json() as { code: string };
    assert.equal(blankResult.code, "CAMERA_FRAME_UNUSABLE");
    assert.equal(actionRequests, 0);
    assert.equal(profileWrites, 2);

    // An isolated development version can inspect a previous reference but
    // must not copy it or activate a profile during preview / Dry Run.
    frame = savedReferenceFrame;
    await stopChild(child);
    const inheritedDirectory = resolve(stateDirectory, "isolated-version");
    const sourceMetadata = await readFile(resolve(stateDirectory,"mock-arm-01.json"));
    child = spawn(process.execPath,["--import","tsx","auto-setup/server.ts"],{
      cwd:process.cwd(),env:{...process.env,SCREENHAND_AUTO_SETUP_PORT:String(autoSetupPort),SCREENHAND_AUTO_SETUP_STATE_DIRECTORY:inheritedDirectory,
        SCREENHAND_AUTO_SETUP_REFERENCE_DIRECTORY:stateDirectory,SCREENHAND_CONTROL_PLANE_URL:`http://127.0.0.1:${controlPlanePort}`},stdio:"ignore",detached:process.platform!=="win32",
    });
    await waitForHealth(`${baseUrl}/health`,child);
    const denied = await fetch(`${baseUrl}/v1/devices/mock-arm-01/run`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    assert.equal(denied.status,409);
    const inheritedDry = await fetch(`${baseUrl}/v1/devices/mock-arm-01/run`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dryRun:true})});
    assert.equal(inheritedDry.status,200);
    const inheritedPreview=await inheritedDry.json() as {preview:{referenceReuse:{status:string}}};
    assert.equal(inheritedPreview.preview.referenceReuse.status,"compatible");
    await assert.rejects(readFile(resolve(inheritedDirectory,"mock-arm-01.json")),(e:unknown)=>(e as NodeJS.ErrnoException).code==="ENOENT");
    assert.equal(actionRequests,0);assert.equal(profileWrites,2);
    const inheritedRun=await fetch(`${baseUrl}/v1/devices/mock-arm-01/run`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirmation:"CLEAR_WORKSPACE_AND_AUTO_SETUP"})});
    assert.equal(inheritedRun.status,200);assert.equal((await inheritedRun.json() as {status:string}).status,"completed");
    assert.ok(await readFile(resolve(inheritedDirectory,"mock-arm-01.json")));
    assert.deepEqual(await readFile(resolve(stateDirectory,"mock-arm-01.json")),sourceMetadata);
    assert.equal(actionRequests,0);assert.equal(profileWrites,3);
  } finally {
    if (child) await stopChild(child);
    await closeServer(mockControlPlane).catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
