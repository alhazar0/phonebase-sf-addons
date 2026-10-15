import { RealtimeMobileAgent } from "./realtime/runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const execute = removeFlag(args, "--execute");
const dryRun = removeFlag(args, "--dry-run");
const fullAccess = removeFlag(args, "--full-access");
const readOnly = removeFlag(args, "--read-only");
const json = removeFlag(args, "--json");
if (execute && dryRun) throw new Error("Choose either --execute or --dry-run, not both.");
if (fullAccess && readOnly) throw new Error("Choose either --full-access or --read-only, not both.");
const deviceId = option(args, "--device") ?? process.env.SCREENHAND_DEVICE_ID ?? "black-arm-01";
const apiUrl = option(args, "--api-url") ?? process.env.SCREENHAND_API_URL ?? "http://127.0.0.1:3023";
const timeoutMs = Number(option(args, "--timeout-ms") ?? "300000");
const artifactDirectory = option(args, "--artifact-directory") ?? "build/runtime";
const resultFile = option(args, "--result-file");
const goal = args.join(" ").trim();

if (!goal) {
  console.error(
    "Usage: npm run agent:realtime -- [--device black-arm-01] [--api-url URL] " +
    "[--timeout-ms 300000] [--artifact-directory PATH] [--result-file PATH] " +
      "[--dry-run|--execute] [--full-access|--read-only] [--json] <goal>",
  );
  process.exit(1);
}

const result = await new RealtimeMobileAgent().run(goal, {
  deviceId,
  apiUrl,
  mode: execute ? "execute" : "dry_run",
  accessMode: readOnly ? "read_only" : "full_access",
  timeoutMs,
  artifactDirectory,
  onEvent: json ? undefined : (event) => {
    const detail = event.detail ? ` ${JSON.stringify(event.detail)}` : "";
    process.stdout.write(`[${new Date(event.at).toISOString()}] ${event.phase}:${event.label}${detail}\n`);
  },
});

if (resultFile) {
  const path = resolve(resultFile);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const summary = result.skill && "latestVideoViewsDisplay" in result.skill
    ? `views=${result.skill.latestVideoViewsDisplay ?? "unavailable"} ` +
      `likes=${result.skill.latestVideoLikesDisplay ?? result.skill.likesVisibility}`
    : result.skill
      ? `likes=${result.skill.likesCompleted} comments=${result.skill.commentsCompleted} ` +
        `videos=${result.skill.videosVisited}`
      : "no-skill-result";
  console.log(`[${result.status}] total=${result.metrics.totalMs}ms ${summary}`);
  if (result.error) console.error(result.error);
}

if (!['completed', 'planned'].includes(result.status)) process.exitCode = 2;

function removeFlag(values: string[], flag: string) {
  const index = values.indexOf(flag);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function option(values: string[], name: string) {
  const index = values.indexOf(name);
  if (index < 0) return null;
  const value = values[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  values.splice(index, 2);
  return value;
}
