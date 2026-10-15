import { resolve } from "node:path";

import {
  evaluateRealCameraCorpus,
  loadRealCameraCorpusManifest,
} from "./real-camera-grounding-corpus";

const args = process.argv.slice(2);
const allowDevelopmentOnly = removeFlag(args, "--allow-development-only");
const manifestPath = resolve(
  args.shift() ?? "benchmarks/real-camera-grounding-2026-09-01.json",
);
if (args.length) throw new Error(`Unexpected arguments: ${args.join(" ")}`);

const manifest = await loadRealCameraCorpusManifest(manifestPath);
const report = await evaluateRealCameraCorpus(manifest, process.cwd(), {
  allowDevelopmentOnly,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gate.passed) process.exitCode = 1;

function removeFlag(values: string[], flag: string) {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}
