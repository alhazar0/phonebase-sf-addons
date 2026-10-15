import test from "node:test";
import assert from "node:assert/strict";
import {readFile,access} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir as osTmpdir} from "node:os";
import {CodexAutonomousPlanner,invokeCodex} from "./codex-planner";
import {createAutonomousPlanner,plannerSettings} from "./planner-factory";
import type {PlanningContext} from "./autonomous-planner";

const decision={kind:"action",reason:"根据当前画面选择一个区域，结果仍需验证",objectives:["返回主页"],achieved:[],finalEvidence:[],
  step:{operation:"tap_region",regionId:"gap_0",beforeTexts:["Heading","Body"],verification:"home",afterTexts:[],afterKeyboard:false,completesObjective:0}};
function context():PlanningContext{return {goal:"返回主页",objectives:[],history:[],capabilities:{home:true,tap:true,swipe:true,longPress:true,inputText:false},
  view:{deviceId:"test",frame:{width:720,height:1280,sequence:1,capturedAt:Date.now(),image:"data:image/jpeg;base64,/9j/2Q=="},
    state:{keyboard:true,overlay:"none"},elements:[],regions:[]}} as unknown as PlanningContext;}

test("Codex receives image plus neutral action contracts, no search recipe; temporary evidence is removed",async()=>{
  let directory="";
  const planner=new CodexAutonomousPlanner({invoke:async input=>{
    directory=input.cwd;
    assert.equal(input.args.includes("--ignore-user-config"),true);assert.equal(input.args.includes("read-only"),true);
    assert.equal(input.args.includes("--ephemeral"),true);assert.equal(input.args.includes("shell_tool"),true);
    const instructions=await readFile(join(directory,"instructions.txt"),"utf8");
    assert.match(instructions,/attached image is the actual camera/);
    assert.doesNotMatch(instructions,/iPhone system search can be dismissed|ios_system_search|screen\.dismissal/);
    assert.doesNotMatch(await readFile(join(directory,"schema.json"),"utf8"),/dismiss_search/);
    assert.equal((await readFile(join(directory,"frame.jpg")))[0],255);
    assert.doesNotMatch(input.prompt,/data:image|imageHash/);
    return {message:JSON.stringify(decision)};
  }});
  assert.equal((await planner.decide(context(),AbortSignal.timeout(1000))).step?.operation,"tap_region");
  assert.equal(planner.imageUploads,1);assert.equal(planner.preferModelNavigation,true);
  await assert.rejects(access(directory));
});
test("Codex invalid output fails closed and clears metadata without leaking the response",async()=>{
  let calls=0;
  const planner=new CodexAutonomousPlanner({invoke:async()=>({message:++calls===1?JSON.stringify(decision):"private-provider-body"})});
  await planner.decide(context(),AbortSignal.timeout(1000));assert.ok(planner.lastResponse);
  await assert.rejects(planner.decide(context(),AbortSignal.timeout(1000)),e=>e instanceof Error&&e.message==="Codex returned an invalid decision contract");
  assert.equal(planner.lastResponse,undefined);
});
test("CLI event boundary accepts only completed inference, passes prompt literally and rejects tools",async()=>{
  const prompt='literal `uname` $(whoami)\nsecond line';
  const script=`let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:s}}));console.log(JSON.stringify({type:'turn.completed'}));});`;
  const base={command:process.execPath,args:["-e",script],cwd:osTmpdir(),prompt,signal:AbortSignal.timeout(3000)};
  assert.equal((await invokeCodex(base)).message,prompt);
  await assert.rejects(invokeCodex({...base,args:["-e",`console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));setInterval(()=>{},1000);`]}),/external tool/);
  await assert.rejects(invokeCodex({...base,args:["-e",`console.log(JSON.stringify({type:'turn.failed',error:{message:'private-secret'}}));`]}),e=>e instanceof Error&&!e.message.includes("private-secret"));
});
test("stopping or timing out planning terminates the CLI instead of returning a late action",async()=>{
  const start=performance.now();
  await assert.rejects(invokeCodex({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:osTmpdir(),prompt:"",signal:AbortSignal.timeout(150)}),e=>e instanceof Error&&e.name==="TimeoutError");
  assert.ok(performance.now()-start<2000);
});
test("provider selection is explicit and Codex does not require an OpenRouter key",()=>{
  const env={NODE_ENV:"test",SCREENHAND_AUTONOMOUS_PROVIDER:"codex"} as NodeJS.ProcessEnv;
  assert.equal(plannerSettings(env).configured,true);assert.ok(createAutonomousPlanner(env) instanceof CodexAutonomousPlanner);
  assert.throws(()=>plannerSettings({...env,SCREENHAND_AUTONOMOUS_PROVIDER:"typo"}),/must be/);
  assert.equal(plannerSettings({NODE_ENV:"test"}).configured,false);
});
