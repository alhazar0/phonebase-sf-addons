import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,writeFile,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {TaskConsoleManager,redact,type Launcher,type RunInput} from "./manager";
const input=():RunInput=>({id:randomUUID(),goal:"返回主页",deviceId:"test-arm",mode:"execute"});
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await mkdtemp(join(tmpdir(),"screenhand-console-test-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const launches:Array<{input:RunInput;reportPath:string;stopCalls:number;output:(s:string)=>void;finish:(code:number)=>void}>=[];
  const launch:Launcher=(input,reportPath,output)=>{
    let finish!:(code:number)=>void;const done=new Promise<{code:number}>(resolve=>{finish=code=>resolve({code});});
    const entry={input,reportPath,output,finish,stopCalls:0};launches.push(entry);return {stop:()=>{entry.stopCalls++;},done};
  };
  const manager=new TaskConsoleManager(root,launch);await manager.initialize();return {root,launches,manager,launch};
}
async function settled(manager:TaskConsoleManager,id:string){for(let i=0;i<50;i++){const detail=await manager.detail(id);if(!["running","stopping"].includes(detail.run.status))return detail;await delay(10);}throw new Error("Manager did not finish");}
test("concurrent duplicate submission launches once, while conflicting IDs and concurrent tasks reject",async t=>{
  const f=await fixture(t),task=input();await Promise.all([f.manager.start(task),f.manager.start(task)]);assert.equal(f.launches.length,1);
  assert.ok((await readFile(join(f.root,task.id,"task.json"),"utf8")).includes(task.goal));
  await assert.rejects(f.manager.start({...task,goal:"Another goal"}),/another task/);
  await assert.rejects(f.manager.start(input()),/已有任务/);assert.equal(f.launches.length,1);
  assert.equal((await stat(join(f.root,task.id,"task.json"))).mode&0o777,0o600);
  await writeFile(f.launches[0].reportPath,JSON.stringify({status:"observed_complete",submissions:[],decisions:[{error:"proposal rejected"}]}));f.launches[0].finish(0);
  const d=await settled(f.manager,task.id);assert.equal(d.run.status,"finished");assert.match(d.run.notes[0].text,/proposal rejected/);
  await f.manager.start(task);assert.equal(f.launches.length,1);
});
test("stop is idempotent, signals the owned worker, and preserves partial evidence",async t=>{
  const f=await fixture(t),task=input();await f.manager.start(task);
  await Promise.all([f.manager.stop(task.id),f.manager.stop(task.id)]);assert.equal(f.launches[0].stopCalls,1);
  await writeFile(f.launches[0].reportPath,JSON.stringify({status:"budget_exhausted",submissions:[{state:"completed",receiptId:"r1"}],error:"Stopped"}));f.launches[0].finish(1);
  const d=await settled(f.manager,task.id);assert.equal(d.run.status,"stopped");assert.equal(d.report?.submissions?.length,1);assert.equal(d.run.needsReview,false);
});
test("uncertain receipt or missing report cannot become success or permit another physical run",async t=>{
  for(const report of [null,{status:"action_uncertain",submissions:[{state:"dispatching"}]}]){
    const f=await fixture(t),task=input();await f.manager.start(task);
    if(report)await writeFile(f.launches[0].reportPath,JSON.stringify(report));f.launches[0].finish(1);
    const d=await settled(f.manager,task.id);assert.equal(d.run.status,"interrupted");assert.equal(d.run.needsReview,true);
    await assert.rejects(f.manager.start(input()),/结果不明/);
  }
});
test("restart keeps history and notes but never resumes an orphaned task",async t=>{
  const f=await fixture(t),task=input();await f.manager.start(task);await f.manager.note(task.id,"按钮没有反应");
  const restarted=new TaskConsoleManager(f.root,f.launch);await restarted.initialize();
  assert.equal(restarted.list()[0].status,"interrupted");assert.equal(restarted.list()[0].notes[0].text,"按钮没有反应");assert.equal(f.launches.length,1);
  await assert.rejects(restarted.start(input()),/结果不明/);
});
test("logs redact common credentials, previews do not enable hardware flags, invalid requests never launch",async t=>{
  const f=await fixture(t),task={...input(),mode:"preview" as const};await f.manager.start(task);
  f.launches[0].output("key sk-or-v1-abcdefghijklmnop Bearer abcdefghijklmnop\n");
  await writeFile(f.launches[0].reportPath,JSON.stringify({status:"preview",submissions:[]}));f.launches[0].finish(0);
  const d=await settled(f.manager,task.id);assert.equal(d.run.status,"finished");assert.doesNotMatch(d.output,/abcdefghijklmnop/);
  await assert.rejects(f.manager.start({...input(),id:"../../outside"}));assert.equal(f.launches.length,1);
  assert.equal(redact("sk-abcdefghijklmnop"),"[REDACTED]");
});
