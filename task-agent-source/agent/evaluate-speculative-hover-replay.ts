import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  evaluateSpeculativeHoverReplay,
  type SpeculativeHoverReplaySource,
} from "./active-world/speculative-hover-replay";
import { readTransitionJournal } from "./active-world/transition-journal";

const args = process.argv.slice(2);
const allowDevelopmentOnly = removeFlag(args, "--allow-development-only");
const directory = resolve(option(args, "--directory") ?? "build/runtime");
if (args.length) {
  throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);
}

const journalPaths = await discoverJournals(directory);
const sources: SpeculativeHoverReplaySource[] = [];
for (const path of journalPaths) {
  const source = await readFile(path, "utf8");
  if (!source.includes('"type":"speculative_hover"')) continue;
  const records = await readTransitionJournal(path);
  const starts = records.filter((record) => record.event.type === "run_started");
  if (starts.length !== 1 || starts[0].event.type !== "run_started") {
    throw new Error(`${path} must contain exactly one run_started record.`);
  }
  sources.push({
    sourceId: relative(directory, path),
    // Historical journals only record the logical device ID. They are marked
    // development/tuning evidence below, so this fallback can never satisfy a
    // production physical-device provenance gate.
    physicalDeviceKey: starts[0].event.deviceId,
    split: "development",
    usedForTuning: true,
    records,
  });
}
if (!sources.length) throw new Error(`No speculative-hover journals found below ${directory}.`);

const report = evaluateSpeculativeHoverReplay(sources);
const { trials, ...summary } = report;
process.stdout.write(`${JSON.stringify({
  directory,
  journalFilesScanned: journalPaths.length,
  speculativeSources: sources.length,
  evidenceClass: "development-only",
  identityNote: "Historical logical device IDs are not physical-phone provenance.",
  ...summary,
  trialSample: trials.slice(0, 20),
}, null, 2)}\n`);
if (!allowDevelopmentOnly && !report.gate.passed) process.exitCode = 2;

async function discoverJournals(root: string) {
  const result: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".transitions.jsonl")) result.push(path);
      if (result.length > 10_000) throw new Error("Journal scan exceeds the 10,000-file limit.");
    }
  }
  return result.sort();
}

function option(values: string[], name: string) {
  const index = values.indexOf(name);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  values.splice(index, 2);
  return value;
}

function removeFlag(values: string[], flag: string) {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}
