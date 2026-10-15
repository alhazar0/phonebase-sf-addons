import { resolve } from "node:path";

import {
  evaluateSemanticWorldModel,
  splitTransitionsByRun,
} from "./active-world/replay-evaluator";
import { loadTransitionsFromJournalDirectory } from "./active-world/semantic-world-model";

const args = process.argv.slice(2);
const directory = resolve(option(args, "--directory") ?? "build/runtime/general-agent");
const holdoutRatio = Number(option(args, "--holdout") ?? "0.2");
if (args.length) throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);
if (!Number.isFinite(holdoutRatio) || holdoutRatio <= 0 || holdoutRatio >= 1) {
  throw new Error("--holdout must be a number between 0 and 1.");
}

const transitions = await loadTransitionsFromJournalDirectory(directory, {
  maximumFiles: 10_000,
});
const split = splitTransitionsByRun(transitions, holdoutRatio);
const metrics = evaluateSemanticWorldModel(split.train, split.test);
process.stdout.write(`${JSON.stringify({
  directory,
  runs: new Set(transitions.map((transition) => transition.runId)).size,
  transitions: transitions.length,
  holdoutRatio,
  metrics,
}, null, 2)}\n`);
if (!split.train.length || !split.test.length) process.exitCode = 2;

function option(values: string[], name: string) {
  const index = values.indexOf(name);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  values.splice(index, 2);
  return value;
}
