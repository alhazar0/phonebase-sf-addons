import { parseArgs } from "node:util";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { CANDIDATES, gradeDecision, hash, probe, summarize, type BenchmarkSample } from "./model-benchmark";
import { loadDecisionCases, type DecisionCase } from "./model-benchmark-cases";
import { autonomousDecisionSchema, autonomousPlanningMessages } from "./autonomous-planner";

dotenv.config({quiet: true});
const {values} = parseArgs({options: {report: {type: "string"}, "recordings-root": {type: "string", default: ".runtime"},
  candidates: {type: "string"}, cases: {type: "string"}, repetitions: {type: "string", default: "1"},
  "timeout-ms": {type: "string", default: "5000"}, "max-requests": {type: "string", default: "60"},
  "max-runtime-ms": {type: "string", default: "600000"}, "dry-run": {type: "boolean", default: false}, rescore: {type: "string"}}});
if (!values.report) throw new Error("Supply --report NEW_FILE; --dry-run validates the corpus without model requests. This command never moves hardware.");
if (values.rescore) {
  // Audit a scorer fix without buying new answers or mutating the source run.
  const bytes = await readFile(resolve(values.rescore));
  if (bytes.length > 8_000_000) throw new Error("Audit source is too large");
  const source = JSON.parse(bytes.toString("utf8"));
  if (source.mode !== "frozen-text-decision-benchmark" || !Array.isArray(source.cases) || !Array.isArray(source.samples) ||
    source.samples.length > 120 || source.cases.length > 100 || hash(source.cases) !== source.corpusHash) throw new Error("Invalid benchmark audit source");
  const samples = (source.samples as BenchmarkSample[]).map(s => {
    const c = (source.cases as DecisionCase[]).find(c => c.id === s.caseId);
    if (!c) throw new Error("Audit case is missing");
    return {...s, grade: s.status === "ok" && s.schemaValid && s.decision ? gradeDecision(autonomousDecisionSchema.parse(s.decision), c) : undefined};
  });
  const path = resolve(values.report); await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const file = await open(path, "wx", 0o600);
  try {await file.writeFile(JSON.stringify({...source, samples, summary: summarize(samples), audit: {
    sourceReport: resolve(values.rescore), sourceHash: hash(source), auditedAt: new Date().toISOString(), newInferenceCalls: 0,
    scoringRevision: "runtime-blocked-exception-v1", explanation: "Initial blocked responses may omit objectives, as AutonomousPhoneRunner permits. Source responses/timings unchanged."}}, null, 2) + "\n"); await file.sync();}
  finally {await file.close();}
  console.log(JSON.stringify({mode: "offline-rescore", report: path, newInferenceCalls: 0, physicalActions: 0, summary: summarize(samples)}, null, 2));
  process.exit(0);
}
function integer(value: string, min: number, max: number) {
  const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}–${max}`); return n;
}
const repetitions = integer(values.repetitions!, 1, 5), timeoutMs = integer(values["timeout-ms"]!, 100, 30_000);
const maxRequests = integer(values["max-requests"]!, 1, 120), maxRuntimeMs = integer(values["max-runtime-ms"]!, 1000, 900_000);
function select<T extends {id: string}>(items: readonly T[], selection?: string): T[] {
  if (!selection) return [...items];
  const ids = selection.split(",");
  if (new Set(ids).size !== ids.length || ids.some(id => !items.some(v => v.id === id))) throw new Error("Unknown or duplicated selection");
  return ids.map(id => items.find(v => v.id === id)!);
}
// Azure is an explicit alternative, never a silent fallback for the OpenAI route.
const candidates = select(values.candidates ? CANDIDATES : CANDIDATES.filter(c => c.id !== "luna-azure-none"), values.candidates);
const cases = select(await loadDecisionCases(values["recordings-root"]!), values.cases);
const plannedRequests = candidates.length * cases.length * repetitions;
if (plannedRequests > maxRequests) throw new Error("Planned requests exceed --max-requests; reduce selections/repetitions or explicitly raise the limit");
if (!values["dry-run"] && !process.env.OPENROUTER_API_KEY?.trim()) throw new Error("Set OPENROUTER_API_KEY in the local .env; never paste it into reports");
const reportPath = resolve(values.report), started = performance.now(), abort = new AbortController();
const stop = () => abort.abort();
const deadline = AbortSignal.timeout(maxRuntimeMs), signal = AbortSignal.any([abort.signal, deadline]);
const samples: BenchmarkSample[] = [];
const unavailable: Array<{candidate: string; httpStatus?: number; reason?: string}> = [];
const manifest = {version: 1, createdAt: new Date().toISOString(), mode: "frozen-text-decision-benchmark", transport: "openrouter",
  physicalActions: 0, imageUploads: 0, defaultModelChanged: false, maxTokens: 1800, timeoutMs, repetitions, plannedRequests,
  candidates, corpusHash: hash(cases), promptHash: hash(autonomousPlanningMessages(cases[0].context)[0]),
  limitations: ["Development corpus: 3 recorded OCR screens plus authored challenges; not held out.",
    "Per-case accepted next decisions are not full task completion or live camera validation.",
    "Reconstructed normalized OCR boxes have uniform confidence; old frame times are intentionally not live.",
    "Sequential, rotated candidate order; no client cache, warmup exclusion, retries or provider fallback.",
    "Provider server-side caching may occur; prompt/reasoning token usage is recorded when returned.",
    "Non-streaming: firstBodyByteMs is NOT time-to-first-generated-token. Latency includes network and validation.",
    "Failures/timeouts are included in all-attempt metrics and score denominators. P95 on a small set is exploratory.",
    "Blocked is correct only on explicitly blocked-capability/ambiguity cases; it is not a completed user task."], cases};
await mkdir(dirname(reportPath), {recursive: true, mode: 0o700});
const reservation = await open(reportPath, "wx", 0o600); await reservation.close();
let temporary: string | undefined;
async function checkpoint(status: string) {
  temporary = `${reportPath}.checkpoint-${process.pid}`;
  const file = await open(temporary, "wx", 0o600);
  try {await file.writeFile(JSON.stringify({...manifest, status, elapsedMs: performance.now() - started, unavailable, samples, summary: summarize(samples)}, null, 2) + "\n"); await file.sync();}
  finally {await file.close();}
  await rename(temporary, reportPath); temporary = undefined;
}
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  await checkpoint(values["dry-run"] ? "corpus_only" : "running");
  console.log(JSON.stringify({mode: manifest.mode, cases: cases.length, candidates: candidates.map(c => c.id), plannedRequests,
    physicalActions: 0, imageUploads: 0, dryRun: values["dry-run"]}));
  if (!values["dry-run"]) {
    outer: for (let repeat = 0; repeat < repetitions; repeat++) for (let index = 0; index < cases.length; index++) {
      for (let offset = 0; offset < candidates.length; offset++) {
        if (signal.aborted) break outer;
        const candidate = candidates[(offset + index + repeat) % candidates.length];
        if (unavailable.some(v => v.candidate === candidate.id)) continue;
        const sample = await probe(candidate, cases[index], {apiKey: process.env.OPENROUTER_API_KEY!, signal, timeoutMs, repeat});
        samples.push(sample); await checkpoint("running");
        console.log(JSON.stringify({candidate: sample.candidate, caseId: sample.caseId, status: sample.status,
          elapsedMs: Math.round(sample.elapsedMs), schemaValid: sample.schemaValid, passed: sample.grade?.passed ?? false,
          issues: sample.grade?.issues, httpStatus: sample.httpStatus, endpointFailure: sample.endpointFailure}));
        // Auth/billing/no-provider errors are configuration failures, not a reason to
        // spend the whole corpus retrying identical requests or loosen privacy.
        if ([401, 402].includes(sample.httpStatus ?? 0)) {
          console.error("Benchmark stopped on authentication/billing; no fallback or privacy changes."); break outer;
        }
        if ([400, 403, 404].includes(sample.httpStatus ?? 0)) unavailable.push({candidate: candidate.id, httpStatus: sample.httpStatus, reason: sample.endpointFailure});
      }
    }
    const status = signal.aborted ? "cancelled" : samples.length === plannedRequests ? "completed" : unavailable.length ? "partial_availability" : "incomplete";
    await checkpoint(status);
    console.log(JSON.stringify({status, report: reportPath, summary: summarize(samples)}, null, 2));
    if (status !== "completed") process.exitCode = 1;
  }
} finally {
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  if (temporary) await unlink(temporary).catch(() => {});
}
