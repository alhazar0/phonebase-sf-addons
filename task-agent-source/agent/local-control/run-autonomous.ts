import { parseArgs } from "node:util";
import { mkdir, mkdtemp, open, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { ScreenHandGeneralAgentClient } from "../general-agent-client";
import { LocalPerceptionService } from "../local-perception/service";
import { actionContextReader } from "../local-perception/action-context";
import { warmVisionOcrDaemon, shutdownVisionOcrDaemon } from "../vision-ocr";
import {createAutonomousPlanner} from "./planner-factory";
import { AutonomousPhoneRunner, type AutonomousReport } from "./autonomous-runner";
import {readTouchAlignment,alignedCalibration} from "./touch-alignment";
import {readIconLibrary,iconResolver} from "./icon-library";
import {calibrationFingerprint} from "./executor";

dotenv.config({quiet: true});
const {values} = parseArgs({options: {device: {type: "string"}, goal: {type: "string"}, report: {type: "string"},
  execute: {type: "boolean", default: false}, "max-decisions": {type: "string", default: "12"},
  "max-actions": {type: "string", default: "64"}, "timeout-ms": {type: "string", default: "90000"},
  "visible-input":{type:"boolean",default:process.env.SCREENHAND_VISIBLE_INPUT==="1"},"alignment-candidate":{type:"boolean",default:false},"icon-library":{type:"string"}}});
if (!values.device || !/^[a-zA-Z0-9._-]{1,120}$/.test(values.device) || !values.goal?.trim() || values.goal.length > 1000 || !values.report) {
  throw new Error("Use --device ID --goal TEXT --report NEW_FILE [--execute] [--max-decisions 12] [--max-actions 12] [--timeout-ms 90000]");
}
const path = resolve(values.report), started = performance.now(), abort = new AbortController();
const stop = () => abort.abort(new Error("Stopped; no further physical submissions"));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180_000) throw new Error("timeout-ms must be 1000–180000");
const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
// Never overwrite a previous run. Atomic snapshots preserve the last durable
// dispatch intent even if the process or computer dies during a later write.
const reservation = await open(path, "wx", 0o600); await reservation.close();
let lock: Awaited<ReturnType<typeof open>> | undefined, lockPath: string | undefined, temporary: string | undefined;
let lastProgress = "";
let lastSnapshot: Record<string, unknown> = {};
async function snapshot(report: Record<string, unknown>) {
  temporary = `${path}.checkpoint-${process.pid}`;
  const f = await open(temporary, "wx", 0o600);
  try {await f.writeFile(JSON.stringify(report, null, 2)); await f.sync();} finally {await f.close();}
  await rename(temporary, path); temporary = undefined; lastSnapshot = report;
}
try {
  await mkdir(".runtime", {recursive: true, mode: 0o700});
  if (values.execute) {
    lockPath = resolve(`.runtime/autonomous-${values.device}.lock`);
    try {lock = await open(lockPath, "wx", 0o600);} catch {throw new Error("This device has an autonomous-run lock. Inspect the prior run/receipt before starting another; locks are not removed automatically after a crash.");}
    await lock.writeFile(JSON.stringify({pid: process.pid, report: path})); await lock.sync();
  }
  const evidenceDirectory = await mkdtemp(`${path}.frames-`), frames: Array<{sequence: number; capturedAt: number; file: string}> = [];
  const saved = new Set<number>(); let bytesSaved = 0;
  const base = process.env.SCREENHAND_API_URL ?? "http://127.0.0.1:3013";
  const alignment=await readTouchAlignment(values.device,values["alignment-candidate"]);
  const client = new ScreenHandGeneralAgentClient(values.device, base, 15000), service = new LocalPerceptionService(base, undefined, undefined, actionContextReader(base));
  const planner = createAutonomousPlanner();
  // The read-only /perception classifier has a separate model; its environment
  // variable must not silently override this executor's selected model.
  const plannerMetadata = () => ({...planner.configuration, lastResponse: planner.lastResponse ?? null});
  const iconLibraryPath=values["icon-library"]??process.env.SCREENHAND_AUTONOMOUS_ICON_LIBRARY;
  const currentCalibration=iconLibraryPath?alignedCalibration(await client.getCalibration(signal),alignment):null;
  if(iconLibraryPath&&!currentCalibration)throw new Error("Icon library requires verified calibration");
  const resolveAppIcons=iconLibraryPath?iconResolver(await readIconLibrary(iconLibraryPath),calibrationFingerprint(currentCalibration!)):undefined;
  console.log(JSON.stringify({planner: plannerMetadata(), execute: values.execute}));
  await warmVisionOcrDaemon(signal); const warmupMs = performance.now() - started;
  const runner = new AutonomousPhoneRunner({deviceId: values.device,
    getDevice: s => client.getDevice(s), getCalibration: async s => alignedCalibration(await client.getCalibration(s),alignment),
    observe: async s => {
      const view = await service.observe(values.device!, {freshOcr: true, signal: s});
      if (!saved.has(view.frame.sequence) && frames.length < 96) {
        const bytes = Buffer.from(view.frame.image.split(",")[1], "base64");
        if (bytesSaved + bytes.length <= 20_000_000) {
          const file = `${evidenceDirectory}/${view.frame.sequence}.jpg`;
          await writeFile(file, bytes, {flag: "wx", mode: 0o600}); saved.add(view.frame.sequence); bytesSaved += bytes.length;
          frames.push({sequence: view.frame.sequence, capturedAt: view.frame.capturedAt, file});
        }
      }
      return view;
    }, act: (action, s, key) => client.executeAction(action, s, {idempotencyKey: key}),
  }, planner);
  const report = await runner.run(values.goal, {execute: values.execute, signal, timeoutMs,
    resolveAppIcons,
    visibleTextEntry:values["visible-input"]&&process.platform==="darwin",
    maximumActions: Number(values["max-actions"]), maximumDecisions: Number(values["max-decisions"]),
    checkpoint: async (r: AutonomousReport) => {
      await snapshot({...r, planner: plannerMetadata(),touchAlignment:alignment, warmupMs, cliElapsedMs: performance.now() - started, evidence: {directory: evidenceDirectory, frames, bytes: bytesSaved}});
      const progress = `${r.phase}/${r.modelCalls}/${r.submissions.length}`;
      if (progress !== lastProgress) {
        console.log(JSON.stringify({phase: r.phase, status: r.status, modelCalls: r.modelCalls, actions: r.submissions.length, elapsedMs: Math.round(performance.now() - started)})); lastProgress = progress;
      }
    },
  });
  console.log(JSON.stringify({status: report.status, error: report.error, objectives: report.objectives, modelCalls: report.modelCalls,
    planner: plannerMetadata(),
    capabilities: report.capabilities, requiredCapabilities: report.requiredCapabilities,
    fieldEntries:report.fieldEntries.map(e=>({field:e.field,value:e.value,status:e.status,elapsedMs:e.elapsedMs})),formStorage:report.formStorage,
    planningTimeoutRetries: report.planningTimeoutRetries,
    imageUploads: report.imageUploads, terminalInterventions: 0, timing: report.timing, cliElapsedMs: performance.now() - started,
    completionEvidence: report.completionEvidence, steps: report.steps.map(s => ({status: s.status, intent: (s.request as {intent?: unknown}).intent, error: s.error, timing: s.timing})), report: path}, null, 2));
  if (!["preview", "observed_complete"].includes(report.status)) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "Autonomous startup failed";
  // Keep already-persisted dispatch/receipt evidence if a later stage fails.
  // Never replace an action-bearing report with a startup-only error object.
  if (temporary) {await unlink(temporary).catch(() => {}); temporary = undefined;}
  const submissions = lastSnapshot.submissions as AutonomousReport["submissions"] | undefined;
  await snapshot({...lastSnapshot, status: submissions?.length ? "action_uncertain" : "failed", error: message, cliElapsedMs: performance.now() - started});
  console.error(message); process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  await shutdownVisionOcrDaemon();
  if (temporary) await unlink(temporary).catch(() => {});
  if (lock) {await lock.close(); await unlink(lockPath!);}
}
