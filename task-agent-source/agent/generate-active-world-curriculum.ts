import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  generateActiveWorldCurriculum,
  type CurriculumGeneratorOptions,
  type PromotionStage,
} from "./active-world/curriculum";

const args = process.argv.slice(2);
const seed = option(args, "--seed") ?? "screenhand-default-curriculum";
const count = Number(option(args, "--count") ?? "100");
const promotionStage = (option(args, "--stage") ?? "simulator") as PromotionStage;
const passedStages = commaList(option(args, "--passed")) as PromotionStage[];
const profilePath = option(args, "--profile");
const outputPath = option(args, "--output");
if (args.length) throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);

let profile: Pick<CurriculumGeneratorOptions, "failureBoundary" | "coverageGaps" | "difficulty"> = {};
if (profilePath) {
  const parsed = JSON.parse(await readFile(resolve(profilePath), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--profile must contain a JSON object.");
  }
  profile = parsed as typeof profile;
}

const curriculum = generateActiveWorldCurriculum({
  seed,
  count,
  promotionStage,
  passedStages,
  ...profile,
});
const output = `${JSON.stringify(curriculum, null, 2)}\n`;
if (outputPath) {
  const absolutePath = resolve(outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, output, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    outputPath: absolutePath,
    seed: curriculum.seed,
    promotionStage: curriculum.promotionStage,
    scenarios: curriculum.scenarioCount,
  }, null, 2)}\n`);
} else {
  process.stdout.write(output);
}

function option(values: string[], name: string) {
  const index = values.indexOf(name);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  values.splice(index, 2);
  return value;
}

function commaList(value: string | null) {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}
