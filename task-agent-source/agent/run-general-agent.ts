import { parseAgentRunRequest } from "./general-agent-contract";
import { ScreenHandGeneralAgentClient } from "./general-agent-client";
import { GeneralMobileAgent } from "./general-mobile-agent";
import { SemanticWorldModel } from "./active-world/semantic-world-model";
import { OpenAIVisionPlanner } from "./vision-model-planner";
import { shutdownVisionOcrDaemon } from "./vision-ocr";

const args = process.argv.slice(2);
const execute = removeFlag(args, "--execute");
const dryRun = removeFlag(args, "--dry-run");
const json = removeFlag(args, "--json");
if (execute && dryRun) throw new Error("Choose either --execute or --dry-run, not both.");
const deviceId = option(args, "--device") ?? process.env.SCREENHAND_DEVICE_ID ?? "black-arm-01";
const apiUrl = option(args, "--api-url") ?? process.env.SCREENHAND_API_URL;
const maxSteps = Number(option(args, "--max-steps") ?? "8");
const timeoutMs = Number(option(args, "--timeout-ms") ?? "45000");
const artifactDirectory = option(args, "--artifact-directory") ?? "build/runtime/general-agent";
const goal = args.join(" ").trim();

if (!goal) {
  console.error(
    "Usage: npm run agent:run -- [--device black-arm-01] [--api-url URL] " +
      "[--max-steps 8] [--timeout-ms 45000] [--artifact-directory PATH] " +
      "[--dry-run|--execute] [--json] <goal>",
  );
  process.exit(1);
}

const request = parseAgentRunRequest({
  deviceId,
  goal,
  mode: execute ? "execute" : "dry_run",
  maxSteps,
  timeoutMs,
});
const worldModel = await SemanticWorldModel.fromJournalDirectory(artifactDirectory);
const agent = new GeneralMobileAgent(
  new ScreenHandGeneralAgentClient(deviceId, apiUrl),
  {
    modelPlanner: OpenAIVisionPlanner.fromEnvironment() ?? undefined,
    activeWorld: { artifactDirectory },
    worldModel,
  },
);
const result = await agent.run(request).finally(() => shutdownVisionOcrDaemon());

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[${result.status}] ${result.reason}`);
  console.log(
    `intent=${result.intent.type} steps=${result.steps} total=${result.metrics.totalMs}ms ` +
      `observe=${result.metrics.averageObservationMs}ms ocr=${result.metrics.averageOcrMs}ms ` +
      `model=${result.metrics.averageModelMs}ms`,
  );
  if (result.plan) {
    console.log(
      `plan=${result.plan.kind}/${result.plan.action.type} ` +
        `confidence=${result.plan.confidence.toFixed(2)}`,
    );
  }
}

if (!["completed", "planned"].includes(result.status)) process.exitCode = 2;

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
