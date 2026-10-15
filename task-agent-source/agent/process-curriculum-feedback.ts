import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ACTIVE_WORLD_CURRICULUM_SCHEMA_VERSION,
  type ActiveWorldCurriculum,
} from "./active-world/curriculum";
import {
  generateNextCurriculum,
  type CurriculumScenarioResult,
} from "./active-world/curriculum-feedback";

const args = process.argv.slice(2);
const curriculumPath = requiredOption(args, "--curriculum");
const resultsPath = requiredOption(args, "--results");
const nextOutputPath = requiredOption(args, "--next-output");
const feedbackOutputPath = option(args, "--feedback-output");
const nextSeed = option(args, "--next-seed") ?? "screenhand-next-curriculum";
const nextCount = Number(option(args, "--next-count") ?? "100");
if (args.length) throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);

const curriculum = JSON.parse(await readFile(resolve(curriculumPath), "utf8")) as ActiveWorldCurriculum;
if (curriculum.schemaVersion !== ACTIVE_WORLD_CURRICULUM_SCHEMA_VERSION || !Array.isArray(curriculum.scenarios)) {
  throw new Error("--curriculum is not a supported Active World curriculum manifest.");
}
const parsedResults = JSON.parse(await readFile(resolve(resultsPath), "utf8")) as unknown;
const results = Array.isArray(parsedResults)
  ? parsedResults
  : (parsedResults as { results?: unknown } | null)?.results;
if (!Array.isArray(results)) throw new Error("--results must be an array or an object containing a results array.");
const next = generateNextCurriculum({
  curriculum,
  results: results as CurriculumScenarioResult[],
  nextSeed,
  count: nextCount,
});
await secureWrite(nextOutputPath, next.curriculum);
if (feedbackOutputPath) await secureWrite(feedbackOutputPath, next.feedback);
process.stdout.write(`${JSON.stringify({
  priorSeed: curriculum.seed,
  nextSeed: next.curriculum.seed,
  suppliedResults: next.feedback.suppliedResults,
  validResults: next.feedback.validResults,
  nextScenarios: next.curriculum.scenarioCount,
  nextOutputPath: resolve(nextOutputPath),
  feedbackOutputPath: feedbackOutputPath ? resolve(feedbackOutputPath) : null,
  highestFailureBoundaries: Object.entries(next.feedback.failureBoundary)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3),
}, null, 2)}\n`);

async function secureWrite(path: string, value: unknown) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

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
