#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD_URL = "http://127.0.0.1:3012";
const API_URL = "http://127.0.0.1:3013";
const INSTALLER_URL = process.env.SCREENHAND_INSTALLER_URL?.trim() ||
  "https://screenhand-remote-console.alhazaranwar205.chatgpt.site/install.sh";
const SERVICE_MANAGER = resolve(ROOT, "scripts/service-manager-macos.py");
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flags = new Set(args.slice(1));

function run(program, programArgs, options = {}) {
  const result = spawnSync(program, programArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    input: options.input,
    env: { ...process.env, SCREENHAND_API_URL: process.env.SCREENHAND_API_URL ?? API_URL },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${program} exited with status ${result.status ?? "unknown"}`);
  }
  return result;
}

async function runStreaming(program, programArgs) {
  const child = spawn(program, programArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, SCREENHAND_API_URL: process.env.SCREENHAND_API_URL ?? API_URL },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  const code = await new Promise((resolveCode) => child.once("exit", resolveCode));
  process.exitCode = typeof code === "number" ? code : 1;
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function serviceStatus() {
  const [health, devices] = await Promise.all([
    fetchJson(`${API_URL}/health`),
    fetchJson(`${API_URL}/api/v1/devices`),
  ]);
  const deviceList = Array.isArray(devices?.devices) ? devices.devices : [];
  return {
    dashboard: Boolean(await fetch(`${DASHBOARD_URL}/`, {
      signal: AbortSignal.timeout(1_500),
    }).then((response) => response.ok).catch(() => false)),
    controlPlane: health?.ok === true,
    deviceCount: deviceList.length,
    connectedDevices: deviceList.filter((device) => device?.connected === true).length,
    touchReadyDevices: deviceList.filter(
      (device) => device?.capabilities?.actions?.tap?.available === true,
    ).length,
    devices: deviceList,
  };
}

function printHelp() {
  process.stdout.write(`ScreenHand developer platform

Usage: screenhand <command> [options]

Getting started
  onboard           Check the Mac, install local services, and open setup
  dashboard         Open the local Dashboard
  docs              Open the local developer documentation
  doctor            Check the Dashboard, API, camera, and controller

Operations
  status [--json]   Show local service and device readiness
  start             Start the local background services
  stop              Stop the local background services
  restart           Restart the local background services
  repair            Reinstall dependencies and local services, then verify
  logs [--follow]   Show local service logs
  audit [--json]    Show the latest hardware action audit events
  update            Install the latest published ScreenHand build
  uninstall         Stop and remove background services; preserve local data

Developer integration
  mcp               Run the local stdio MCP server
  agent-guide       Print the complete Agent handoff
  agent-guide --copy
                    Copy the complete Agent handoff to the clipboard

Other
  version           Print the installed version
  help              Show this help

Safety: installation and onboarding never home or move the arm.
`);
}

async function confirm(prompt, expected = "y") {
  if (!process.stdin.isTTY) return false;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question(prompt)).trim().toLowerCase();
    return answer === expected || (expected === "y" && answer === "yes");
  } finally {
    input.close();
  }
}

async function onboard() {
  if (process.platform !== "darwin") {
    throw new Error("ScreenHand currently supports macOS only.");
  }
  process.stdout.write(`
ScreenHand onboarding
---------------------
This setup installs local services on ports 3012 and 3013.
It will not home or move the arm.

`);
  if (!flags.has("--prepared")) run("./scripts/setup-macos.sh", []);
  run("python3", [SERVICE_MANAGER, "install"]);

  const deadline = Date.now() + 15_000;
  let state = await serviceStatus();
  while ((!state.dashboard || !state.controlPlane) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    state = await serviceStatus();
  }
  run("./scripts/doctor.sh", [], { allowFailure: true });

  process.stdout.write(`
Software setup is complete.

Next:
1. Connect one ScreenHand controller and one UVC camera.
2. Open Connections in the Dashboard.
3. Clear hands, cables, and tools before confirming Home.
4. Complete four-point calibration.
5. Use the Dashboard, REST API, or MCP.

Dashboard: ${DASHBOARD_URL}
Docs:      ${DASHBOARD_URL}/docs

`);
  const shouldOpen = !flags.has("--no-open");
  if (shouldOpen) run("open", [DASHBOARD_URL], { allowFailure: true });
}

async function printStatus() {
  const state = await serviceStatus();
  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  process.stdout.write(`ScreenHand status

${state.dashboard ? "✓" : "✗"} Dashboard     ${DASHBOARD_URL}
${state.controlPlane ? "✓" : "✗"} Control API  ${API_URL}
${state.connectedDevices ? "✓" : "!"} Devices      ${state.connectedDevices} connected
${state.touchReadyDevices ? "✓" : "!"} Touch ready  ${state.touchReadyDevices}
`);
}

async function update() {
  const temporary = await mkdtemp(resolve(tmpdir(), "screenhand-update-"));
  const target = resolve(temporary, "install.sh");
  try {
    const response = await fetch(INSTALLER_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Installer download returned HTTP ${response.status}.`);
    await writeFile(target, await response.text(), { mode: 0o700 });
    run("/bin/bash", [target, "--no-onboard"]);
    run("python3", [SERVICE_MANAGER, "restart"]);
    await printStatus();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function showLogs() {
  const logDirectory = resolve(ROOT, ".runtime");
  const files = [
    resolve(logDirectory, "dashboard.log"),
    resolve(logDirectory, "dashboard-error.log"),
    resolve(logDirectory, "control-plane.log"),
    resolve(logDirectory, "control-plane-error.log"),
    resolve(logDirectory, "fleet.log"),
    resolve(logDirectory, "fleet-error.log"),
  ];
  if (flags.has("--follow")) {
    await runStreaming("tail", ["-n", "100", "-f", ...files]);
  } else {
    run("tail", ["-n", "50", ...files], { allowFailure: true });
    process.stdout.write(`\nLog directory: ${logDirectory}\n`);
  }
}

async function showAudit() {
  const auditPath = resolve(ROOT, "build/runtime/audit.jsonl");
  let entries = [];
  try {
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
    entries = lines.slice(-100).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write("No hardware action audit events have been recorded.\n");
    return;
  }
  for (const entry of entries) {
    process.stdout.write(
      `${entry.at} ${entry.status.padEnd(9)} ${entry.actionType.padEnd(12)} ${entry.deviceId} receipt=${entry.receiptId} actor=${entry.actor}${entry.error ? ` error=${entry.error}` : ""}\n`,
    );
  }
}

async function agentGuide() {
  const guide = await readFile(resolve(ROOT, "public/agent-guide.txt"), "utf8");
  if (flags.has("--copy")) {
    run("pbcopy", [], { input: guide });
    process.stdout.write("ScreenHand Agent guide copied to the clipboard.\n");
  } else {
    process.stdout.write(guide);
  }
}

async function uninstall() {
  const approved = flags.has("--yes") || await confirm(
    "Stop and remove ScreenHand background services? Local app data will be preserved. [y/N] ",
  );
  if (!approved) {
    process.stdout.write("Uninstall cancelled.\n");
    return;
  }
  run("python3", [SERVICE_MANAGER, "uninstall"]);
  process.stdout.write(`Background services removed. Local files remain in ${ROOT}.\n`);
}

try {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version": {
      const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
      process.stdout.write(`${pkg.version}\n`);
      break;
    }
    case "setup":
      run("./scripts/setup-macos.sh", []);
      break;
    case "onboard":
      await onboard();
      break;
    case "dashboard":
      run("open", [DASHBOARD_URL]);
      break;
    case "docs":
      run("open", [`${DASHBOARD_URL}/docs`]);
      break;
    case "doctor":
      run("./scripts/doctor.sh", []);
      break;
    case "status":
      await printStatus();
      break;
    case "start":
    case "stop":
    case "restart":
      run("python3", [SERVICE_MANAGER, command]);
      break;
    case "repair":
      run("./scripts/setup-macos.sh", []);
      run("python3", [SERVICE_MANAGER, "install"]);
      run("./scripts/doctor.sh", [], { allowFailure: true });
      break;
    case "logs":
      await showLogs();
      break;
    case "audit":
      await showAudit();
      break;
    case "update":
      await update();
      break;
    case "uninstall":
      await uninstall();
      break;
    case "mcp":
      await runStreaming("npm", ["run", "--silent", "mcp"]);
      break;
    case "agent-guide":
      await agentGuide();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printHelp();
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`ScreenHand: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
