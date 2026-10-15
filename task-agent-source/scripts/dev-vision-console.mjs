#!/usr/bin/env node

import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const processes = new Map();
let stopping = false;
let finalExitCode = 0;

function start(name, script, environment = {}) {
  const child = spawn(npmCommand, ["run", script], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  processes.set(name, child);
  child.on("error", (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
    beginShutdown("SIGTERM", 1);
  });
  child.on("exit", (code, signal) => {
    processes.delete(name);
    if (!stopping) {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      console.error(`[${name}] stopped unexpectedly (${detail}).`);
      beginShutdown("SIGTERM", code && code > 0 ? code : 1);
      return;
    }
    finishWhenStopped();
  });
}

function signalProcessTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function beginShutdown(signal, exitCode) {
  if (stopping) return;
  stopping = true;
  finalExitCode = exitCode;
  for (const child of processes.values()) {
    signalProcessTree(child, signal);
  }
  setTimeout(() => {
    for (const child of processes.values()) {
      signalProcessTree(child, "SIGKILL");
    }
  }, 4_000).unref();
  finishWhenStopped();
}

function finishWhenStopped() {
  if (stopping && processes.size === 0) process.exit(finalExitCode);
}

process.on("SIGINT", () => beginShutdown("SIGINT", 0));
process.on("SIGTERM", () => beginShutdown("SIGTERM", 0));

// The development UI and realtime Agent deliberately reuse the protected
// stable control-plane API. The API keeps all homing, calibration, freshness,
// and idempotency gates in force while the experimental Agent remains isolated
// on :3024. SCREENHAND_PHYSICAL_CONTROL_PLANE_URL is a separate opt-in so an
// old :3023 development override cannot silently disconnect the real arm.
const physicalControlPlaneUrl =
  process.env.SCREENHAND_PHYSICAL_CONTROL_PLANE_URL ?? "http://127.0.0.1:3013";
const realtimeAgentUrl =
  process.env.SCREENHAND_REALTIME_URL ?? "http://127.0.0.1:3024";
const developmentAutoSetupPort =
  process.env.SCREENHAND_DEVELOPMENT_AUTO_SETUP_PORT ?? "3032";
const developmentAutoSetupUrl =
  process.env.SCREENHAND_DEVELOPMENT_AUTO_SETUP_URL ??
  `http://127.0.0.1:${developmentAutoSetupPort}`;

// This experimental branch defaults to a model-free observation service.
// The legacy generative runtime is an explicit opt-in, never a hidden fallback.
const generativeModelsEnabled = process.env.SCREENHAND_GENERATIVE_MODELS_ENABLED === "1";
const localPerceptionUrl = process.env.SCREENHAND_PERCEPTION_URL ?? "http://127.0.0.1:3026";

console.log(
  `Starting ScreenHand console :3011 → ${generativeModelsEnabled ? `realtime Agent ${realtimeAgentUrl}` : `local perception ${localPerceptionUrl}`} → ` +
  `physical control ${physicalControlPlaneUrl}; vision auto-setup ` +
  developmentAutoSetupUrl,
);
start("vision-auto-setup", "auto-setup", {
  SCREENHAND_AUTO_SETUP_PORT: developmentAutoSetupPort,
  SCREENHAND_CONTROL_PLANE_URL: physicalControlPlaneUrl,
  SCREENHAND_AUTO_SETUP_STATE_DIRECTORY:
    process.env.SCREENHAND_DEVELOPMENT_AUTO_SETUP_STATE_DIRECTORY ??
    ".runtime/auto-setup-3011",
  // This paired stable checkout is read-only; new saves remain isolated above.
  SCREENHAND_AUTO_SETUP_REFERENCE_DIRECTORY:
    process.env.SCREENHAND_DEVELOPMENT_AUTO_SETUP_REFERENCE_DIRECTORY ??
    "../phonebase/.runtime/auto-setup",
});
if (generativeModelsEnabled) {
  start("realtime-agent", "agent:realtime:server", { SCREENHAND_API_URL: physicalControlPlaneUrl });
} else {
  console.log("Legacy realtime task bar disabled. Local observation: /perception; independent autonomous entry: /tasks (explicit submission only).");
}
start("local-perception", "perception:server", { SCREENHAND_API_URL: physicalControlPlaneUrl });
start("task-console", "tasks:server", { SCREENHAND_API_URL: physicalControlPlaneUrl });
start("console", "dev:3011:ui", {
  SCREENHAND_LOCAL_CONTROL_PLANE_URL: physicalControlPlaneUrl,
  NEXT_PUBLIC_SCREENHAND_LOCAL_CONTROL_PLANE_URL: physicalControlPlaneUrl,
  SCREENHAND_REALTIME_URL: realtimeAgentUrl,
  SCREENHAND_AUTO_SETUP_URL: developmentAutoSetupUrl,
  SCREENHAND_PERCEPTION_URL: localPerceptionUrl,
  SCREENHAND_TASK_CONSOLE_URL: process.env.SCREENHAND_TASK_CONSOLE_URL ?? "http://127.0.0.1:3027",
  NEXT_PUBLIC_SCREENHAND_LOCAL_PERCEPTION_ONLY: generativeModelsEnabled ? "0" : "1",
});
