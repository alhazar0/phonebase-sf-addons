import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  evaluatePromotionGate,
  type PromotionGateEvidence,
} from "./active-world/promotion-gate";

const args = process.argv.slice(2);
const evidencePath = option(args, "--evidence");
if (!evidencePath) throw new Error("--evidence requires a JSON file.");
if (args.length) throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);
const parsed = JSON.parse(await readFile(resolve(evidencePath), "utf8")) as unknown;
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error("--evidence must contain a JSON object.");
}
const decision = evaluatePromotionGate(parsed as PromotionGateEvidence);
process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
if (!decision.passed) process.exitCode = 2;

function option(values: string[], name: string) {
  const index = values.indexOf(name);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  values.splice(index, 2);
  return value;
}
