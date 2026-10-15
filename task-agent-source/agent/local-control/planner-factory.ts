import {OpenRouterAutonomousPlanner,DEFAULT_AUTONOMOUS_MODEL} from "./autonomous-planner";
import {CodexAutonomousPlanner,DEFAULT_CODEX_MODEL} from "./codex-planner";

export function plannerSettings(env:NodeJS.ProcessEnv=process.env){
  const provider=env.SCREENHAND_AUTONOMOUS_PROVIDER??"openrouter";
  if(provider!=="codex"&&provider!=="openrouter")throw new Error("SCREENHAND_AUTONOMOUS_PROVIDER must be codex or openrouter");
  return provider==="codex"?{provider,model:env.SCREENHAND_CODEX_MODEL??DEFAULT_CODEX_MODEL,
    timeoutMs:Number(env.SCREENHAND_CODEX_TIMEOUT_MS??"45000"),configured:true}:
    {provider,model:env.SCREENHAND_AUTONOMOUS_MODEL??DEFAULT_AUTONOMOUS_MODEL,
      timeoutMs:Number(env.SCREENHAND_AUTONOMOUS_TIMEOUT_MS??"10000"),configured:!!env.OPENROUTER_API_KEY?.trim()};
}
export function createAutonomousPlanner(env:NodeJS.ProcessEnv=process.env){
  const settings=plannerSettings(env);
  return settings.provider==="codex"?new CodexAutonomousPlanner({command:env.SCREENHAND_CODEX_COMMAND,model:settings.model,timeoutMs:settings.timeoutMs}):
    new OpenRouterAutonomousPlanner({apiKey:env.OPENROUTER_API_KEY??"",model:settings.model,timeoutMs:settings.timeoutMs});
}
