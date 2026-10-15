import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  evaluatePhysicalMobileWorld,
  physicalWorldReportToPromotionEvidence,
  type PhysicalMobileWorldRun,
  type PhysicalMobileWorldSoakSession,
} from "./active-world/physical-mobile-world";
import { evaluatePromotionGate } from "./active-world/promotion-gate";
import type { PromotionStage } from "./active-world/curriculum";

const args = process.argv.slice(2);
const inputPath = requiredOption(args, "--input");
const reportOutputPath = option(args, "--report-output");
const stage = option(args, "--stage") as PromotionStage | null;
const passedStages = commaList(option(args, "--passed")) as PromotionStage[];
const baselineSuccess = optionalNumber(args, "--baseline-success");
const baselineDurationP50Ms = optionalNumber(args, "--baseline-duration-p50-ms");
if (args.length) throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);

const parsed = JSON.parse(await readFile(resolve(inputPath), "utf8")) as {
  runs?: unknown;
  soakSessions?: unknown;
};
if (!parsed || !Array.isArray(parsed.runs)) {
  throw new Error("--input must contain a runs array.");
}
if (parsed.soakSessions !== undefined && !Array.isArray(parsed.soakSessions)) {
  throw new Error("soakSessions must be an array when supplied.");
}
const report = evaluatePhysicalMobileWorld(
  parsed.runs as PhysicalMobileWorldRun[],
  (parsed.soakSessions ?? []) as PhysicalMobileWorldSoakSession[],
);
const gate = stage
  ? evaluatePromotionGate(physicalWorldReportToPromotionEvidence({
      report,
      stage,
      passedStages,
      baselineSuccessRate: requiredFinite(baselineSuccess, "--baseline-success"),
      baselineTaskDurationP50Ms: requiredPositive(
        baselineDurationP50Ms,
        "--baseline-duration-p50-ms",
      ),
    }))
  : null;
const output = { report, gate };
if (reportOutputPath) {
  const absolutePath = resolve(reportOutputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(output, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    reportOutputPath: absolutePath,
    totalRuns: report.totalRuns,
    certifiedRuns: report.certifiedRuns,
    certifiedSuccessRate: report.certifiedSuccessRate,
    taskDurationP50Ms: report.taskDurationMs.p50,
    taskDurationP95Ms: report.taskDurationMs.p95,
    gatePassed: gate?.passed ?? null,
    blockers: gate?.blockers ?? [],
  }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
if (gate && !gate.passed) process.exitCode = 2;

function requiredOption(values: string[], name: string) {
  const value = option(values, name);
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function option(values: string[], name: string) {
  const index = values.indexOf(name);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  values.splice(index, 2);
  return value;
}

function optionalNumber(values: string[], name: string) {
  const value = option(values, name);
  return value === null ? null : Number(value);
}

function requiredFinite(value: number | null, name: string) {
  if (value === null || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function requiredPositive(value: number | null, name: string) {
  const result = requiredFinite(value, name);
  if (result <= 0) throw new Error(`${name} must be greater than zero.`);
  return result;
}

function commaList(value: string | null) {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}
