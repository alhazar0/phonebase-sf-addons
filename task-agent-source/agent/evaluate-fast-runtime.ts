import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
  evaluateFastRuntimeGate,
  fastRuntimeEvidenceFromResult,
} from "./realtime/fast-runtime-gate";

const paths = process.argv.slice(2);
if (paths.length < 3) {
  console.error("Usage: npm run agent:fast-gate -- result-1.json result-2.json result-3.json");
  process.exit(2);
}
const evidence = await Promise.all(paths.map(async (path) =>
  fastRuntimeEvidenceFromResult(
    JSON.parse(await readFile(path, "utf8")),
    basename(path) === "result.json" ? basename(dirname(path)) : basename(path),
  )
));
const report = evaluateFastRuntimeGate(evidence);
console.log(JSON.stringify({ evidence, report }, null, 2));
if (!report.passed) process.exitCode = 2;
