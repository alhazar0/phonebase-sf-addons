import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { shutdownVisionOcrDaemon, warmVisionOcrDaemon } from "../vision-ocr";
import { ScreenHandGeneralAgentClient } from "../general-agent-client";
import { GeneralMobileAgent } from "../general-mobile-agent";
import { OpenAIVisionPlanner } from "../vision-model-planner";
import { SemanticWorldModel } from "../active-world/semantic-world-model";
import { HybridTaskCompiler } from "../task-compiler";
import type { TaskProgram } from "../task-ir";
import { UniversalTaskAgent } from "../task-runner";
import { RealtimeFrameHub } from "./frame-hub";
import { LiveGeneralAgentClient } from "./live-general-client";
import { WarmGeneralDeviceRuntime } from "./warm-general-runtime";
import {
  parseRealtimeRunApiRequest,
  RealtimeRunApiValidationError,
  selectRuntimeEngine,
  summarizeRealtimeUpstream,
} from "./server-contract";

const host = process.env.SCREENHAND_REALTIME_HOST ?? "127.0.0.1";
const port = boundedPort(process.env.SCREENHAND_REALTIME_PORT, 3024);
const controlPlaneUrl = process.env.SCREENHAND_API_URL ?? "http://127.0.0.1:3013";
const defaultDeviceId = process.env.SCREENHAND_DEVICE_ID ?? "black-arm-01";
const activeDevices = new Set<string>();
let visionReady = false;
let shuttingDown = false;
const serviceWorldModel = SemanticWorldModel.fromJournalTree(
  resolve("build/runtime/service"),
  { maximumFiles: 10_000, maximumTransitions: 100_000 },
);
const serviceDeviceRuntimes = new Map<string, Promise<WarmGeneralDeviceRuntime>>();
const serviceVisionPlanner = OpenAIVisionPlanner.fromEnvironment();
const serviceTaskCompiler = HybridTaskCompiler.fromEnvironment();

const warmup = warmVisionOcrDaemon()
  .then(() => {
    visionReady = true;
    process.stdout.write("[realtime-service] local Vision OCR is warm\n");
  })
  .catch((error) => {
    process.stderr.write(`[realtime-service] OCR warmup failed: ${errorMessage(error)}\n`);
  });

void warmup.then(() => warmGeneralRuntime(
  process.env.SCREENHAND_DEVICE_ID ?? "black-arm-01",
)).then((runtime) => {
  process.stdout.write(
    `[realtime-service] generic perception warm at frame ${runtime.summary().lastObservedSequence}\n`,
  );
}).catch((error) => {
  process.stderr.write(`[realtime-service] generic perception warmup deferred: ${errorMessage(error)}\n`);
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const upstream = await readUpstreamReadiness(defaultDeviceId);
      return json(response, 200, {
        ok: true,
        visionReady,
        activeDevices: [...activeDevices],
        controlPlaneUrl,
        defaultAccessMode: "full_access",
        visualPlannerReady: serviceVisionPlanner !== null,
        universalTaskCompilerReady: true,
        incrementalSceneGraphReady: true,
        universalPopupGuardianReady: true,
        upstream,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/realtime/runs") {
      const input = parseRealtimeRunApiRequest(await readJson(request));
      if (activeDevices.has(input.deviceId)) {
        return json(response, 409, {
          ok: false,
          error: `Device ${input.deviceId} already has an active realtime task.`,
        });
      }
      activeDevices.add(input.deviceId);
      try {
        await warmup;
        const artifactDirectory = resolve(
          "build/runtime/service",
          `${Date.now()}-${safeSegment(input.deviceId)}`,
        );
        const engine = selectRuntimeEngine(input.goal);
        const program = await serviceTaskCompiler.compile(input.goal, {
          accessMode: input.accessMode,
        });
        process.stdout.write(
          `[${new Date().toISOString()}] ${input.deviceId} compile:${program.compiler.strategy} ` +
          `steps=${program.steps.length} elapsed=${program.compiler.elapsedMs}ms ` +
          `cache=${program.compiler.cacheHit}\n`,
        );
        const result = await runUniversalTask(input, artifactDirectory, program);
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          resolve(artifactDirectory, "result.json"),
          `${JSON.stringify(result, null, 2)}\n`,
          { mode: 0o600 },
        );
        return json(response, result.status === "failed" ? 500 : 200, {
          ok: result.status === "completed" || result.status === "planned",
          engine,
          artifactDirectory,
          result,
        });
      } finally {
        activeDevices.delete(input.deviceId);
      }
    }
    return json(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    if (error instanceof RealtimeRunApiValidationError) {
      return json(response, 400, { ok: false, error: error.message });
    }
    process.stderr.write(`[realtime-service] ${errorMessage(error)}\n`);
    return json(response, 500, { ok: false, error: errorMessage(error) });
  }
});

async function readUpstreamReadiness(deviceId: string) {
  try {
    const device = await new ScreenHandGeneralAgentClient(
      deviceId,
      controlPlaneUrl,
    ).getDevice(AbortSignal.timeout(800));
    return summarizeRealtimeUpstream(deviceId, device);
  } catch (error) {
    return summarizeRealtimeUpstream(
      deviceId,
      null,
      `Physical control unavailable: ${errorMessage(error)}`,
    );
  }
}

async function runUniversalTask(
  input: ReturnType<typeof parseRealtimeRunApiRequest>,
  artifactDirectory: string,
  program: TaskProgram,
) {
  if (input.mode === "dry_run") {
    return new UniversalTaskAgent({
      run: async () => {
        throw new Error("Dry Run must not initialize the visual executor.");
      },
    }).run(program, {
      deviceId: input.deviceId,
      mode: input.mode,
      timeoutMs: input.timeoutMs,
      artifactDirectory,
    });
  }
  const runtime = await warmGeneralRuntime(
    input.deviceId,
    Math.min(5_000, input.timeoutMs),
  );
  const { frames, observer } = runtime;
  const worldModel = await serviceWorldModel;
  const control = new ScreenHandGeneralAgentClient(input.deviceId, controlPlaneUrl);
  const stepAgent = new GeneralMobileAgent(
    new LiveGeneralAgentClient(control, frames),
    {
      observer,
      modelPlanner: serviceVisionPlanner ?? undefined,
      activeWorld: { artifactDirectory },
      worldModel,
      accessMode: input.accessMode,
    },
  );
  return new UniversalTaskAgent(stepAgent, {
    lookaheadPredictor: worldModel,
  }).run(program, {
    deviceId: input.deviceId,
    mode: input.mode,
    timeoutMs: input.timeoutMs,
    artifactDirectory,
  });
}

function warmGeneralRuntime(deviceId: string, connectTimeoutMs = 5_000) {
  const existing = serviceDeviceRuntimes.get(deviceId);
  if (existing) return existing;
  const pending = (async () => {
    const runtime = new WarmGeneralDeviceRuntime(new RealtimeFrameHub({
      deviceId,
      controlPlaneUrl,
      modelLongEdge: 1_024,
    }), {
      onError: (error) => process.stderr.write(
        `[realtime-service] ${deviceId} warm perception stopped: ${error.message}\n`,
      ),
    });
    try {
      await runtime.start(connectTimeoutMs);
      return runtime;
    } catch (error) {
      serviceDeviceRuntimes.delete(deviceId);
      await runtime.stop();
      throw error;
    }
  })();
  serviceDeviceRuntimes.set(deviceId, pending);
  return pending;
}

server.listen(port, host, () => {
  process.stdout.write(`[realtime-service] listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[realtime-service] ${signal}; stopping\n`);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await Promise.all([...serviceDeviceRuntimes.values()].map(async (runtime) =>
    (await runtime).stop()
  ));
  await shutdownVisionOcrDaemon();
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 32_768) throw new RealtimeRunApiValidationError("Request body is too large.");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new RealtimeRunApiValidationError("Request body must be valid JSON.");
  }
}

function json(response: ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  response.end(body);
}

function boundedPort(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535) return fallback;
  return parsed;
}

function safeSegment(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
