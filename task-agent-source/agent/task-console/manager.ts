import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir,open,readFile,readdir,rename,stat} from "node:fs/promises";
import {join,resolve} from "node:path";
import {z} from "zod";

export const runInputSchema=z.object({id:z.string().uuid(),deviceId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  goal:z.string().trim().min(1).max(1000),mode:z.enum(["execute","preview"]).default("execute")}).strict();
export type RunInput=z.infer<typeof runInputSchema>;
export type ConsoleRun=RunInput&{status:"running"|"stopping"|"finished"|"stopped"|"failed"|"interrupted";
  createdAt:string;updatedAt:string;resultStatus?:string;error?:string;exitCode?:number|null;needsReview?:boolean;notes:Array<{at:string;text:string}>};
export type RunReport={status?:string;error?:string;phase?:string;modelCalls?:number;timing?:Record<string,number>;
  submissions?:Array<{state:string}>;[key:string]:unknown};
export type RunDetail={run:ConsoleRun;report:RunReport|null;output:string};
type Child={stop:()=>void;done:Promise<{code:number|null;signal?:string|null}>};
export type Launcher=(input:RunInput,reportPath:string,onOutput:(text:string)=>void)=>Child;
export class ConsoleError extends Error {constructor(readonly status:number,message:string){super(message);}}
const active=(r:ConsoleRun)=>r.status==="running"||r.status==="stopping";
export const redact=(text:string)=>text.replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.+/-]{12,})/gi,"[REDACTED]");
async function atomicJson(path:string,value:unknown){
  const temporary=`${path}.${randomUUID()}.tmp`,file=await open(temporary,"wx",0o600);
  try{await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}
  await rename(temporary,path);
}

/** Durable task lifecycle around the SAME autonomous CLI used in development.
 * No scripts per app, hidden fallback, shell interpolation or GET-triggered work. */
export class TaskConsoleManager {
  private runs=new Map<string,ConsoleRun>();
  private children=new Map<string,Child>();
  private gate:Promise<unknown>=Promise.resolve();
  private logs=new Map<string,Promise<void>>();
  private logBytes=new Map<string,number>();
  private closing=false;
  readonly root:string;
  constructor(root:string,private launch:Launcher,private beforeStart?:(input:RunInput)=>Promise<void>){this.root=resolve(root);}
  private exclusive<T>(fn:()=>Promise<T>):Promise<T>{const next=this.gate.then(fn,fn);this.gate=next.catch(()=>{});return next;}
  private directory(id:string){if(!z.string().uuid().safeParse(id).success)throw new ConsoleError(400,"Invalid task ID");return join(this.root,id);}
  private async persist(run:ConsoleRun){await atomicJson(join(this.directory(run.id),"task.json"),run);}
  async initialize(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    for(const entry of await readdir(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!z.string().uuid().safeParse(entry.name).success)continue;
      const path=join(this.root,entry.name,"task.json");
      const info=await stat(path);if(info.size>1_000_000)throw new Error("Task metadata is oversized; inspect local records before restarting");
      const run=JSON.parse(await readFile(path,"utf8")) as ConsoleRun;
      runInputSchema.parse({id:run.id,deviceId:run.deviceId,goal:run.goal,mode:run.mode});
      if(run.id!==entry.name||!Array.isArray(run.notes))throw new Error("Invalid saved task metadata");
      // A server restart never resumes a robot task or forgets an uncertain one.
      if(active(run)){run.status="interrupted";run.needsReview=run.mode==="execute";run.error="任务服务曾中断。未自动恢复；请检查最后动作与手机状态。";run.updatedAt=new Date().toISOString();await this.persist(run);}
      this.runs.set(run.id,run);
    }
  }
  list(){return [...this.runs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(r=>structuredClone(r));}
  private get(id:string){this.directory(id);const run=this.runs.get(id);if(!run)throw new ConsoleError(404,"Task not found");return run;}
  async report(id:string):Promise<RunReport|null>{
    this.get(id);const path=join(this.directory(id),"report.json");
    try{const info=await stat(path);if(info.size>4_000_000)throw new ConsoleError(413,"Task report exceeds limit");
      const text=await readFile(path,"utf8");if(!text.trim())return null;
      return JSON.parse(redact(text)) as RunReport;
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
  }
  async detail(id:string):Promise<RunDetail>{
    const run=structuredClone(this.get(id));let output="";
    try{output=await readFile(join(this.directory(id),"output.log"),"utf8");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    return {run,report:await this.report(id),output:output.slice(-24_000)};
  }
  async start(value:unknown){const input=runInputSchema.parse(value);return this.exclusive(async()=>{
    const existing=this.runs.get(input.id);
    if(existing){if(existing.goal!==input.goal||existing.deviceId!==input.deviceId||existing.mode!==input.mode)throw new ConsoleError(409,"This request ID already belongs to another task");return structuredClone(existing);}
    if(this.closing)throw new ConsoleError(503,"Task service is stopping");
    if(this.runs.size>=100)throw new ConsoleError(507,"已保存 100 份任务，请先归档本地记录；不会自动删除日志。");
    if([...this.runs.values()].some(active))throw new ConsoleError(409,"已有任务正在执行或停止，请勿同时控制机械臂。");
    if(input.mode==="execute"&&[...this.runs.values()].some(r=>r.deviceId===input.deviceId&&r.needsReview))throw new ConsoleError(409,"该设备有结果不明的历史动作，请先检查对应日志；不会自动重试。");
    await this.beforeStart?.(input);
    const now=new Date().toISOString(),run:ConsoleRun={...input,status:"running",createdAt:now,updatedAt:now,notes:[]};
    await mkdir(this.directory(input.id),{mode:0o700});await this.persist(run);this.runs.set(run.id,run);
    try{
      const child=this.launch(input,join(this.directory(run.id),"report.json"),text=>this.recordOutput(run.id,text));this.children.set(run.id,child);
      void child.done.then(exit=>this.exclusive(()=>this.finish(run.id,exit)),error=>this.exclusive(()=>this.finish(run.id,{code:1},String(error)))).catch(()=>{run.status="interrupted";run.needsReview=run.mode==="execute";run.error="无法保存最终日志，请检查本地文件。";this.children.delete(run.id);});
    }catch(error){await this.finish(run.id,{code:1},error instanceof Error?error.message:"Could not start worker");}
    return structuredClone(run);
  });}
  private recordOutput(id:string,text:string){
    const bytes=this.logBytes.get(id)??0;if(bytes>=128_000)return;
    const chunk=redact(text).slice(0,Math.max(0,128_000-bytes));this.logBytes.set(id,bytes+Buffer.byteLength(chunk));
    const next=(this.logs.get(id)??Promise.resolve()).then(async()=>{
      const f=await open(join(this.directory(id),"output.log"),"a",0o600);try{await f.writeFile(chunk);}finally{await f.close();}
    });this.logs.set(id,next);
    void next.catch(()=>this.children.get(id)?.stop());
  }
  private async finish(id:string,exit:{code:number|null;signal?:string|null},error?:string){
    const run=this.get(id);await this.logs.get(id);
    const report=await this.report(id);
    const uncertain=report?.submissions?.some(s=>s.state!=="completed")||report?.status==="action_uncertain";
    run.needsReview=run.mode==="execute"&&Boolean(uncertain||!report);
    const stopped=run.status==="stopping";
    run.resultStatus=report?.status;
    run.status=run.needsReview?"interrupted":stopped?"stopped":exit.code===0&&["preview","observed_complete"].includes(report?.status??"")?"finished":"failed";
    run.error=redact(error??report?.error??(exit.code===0?"":"任务进程异常退出，请查看日志。"));
    run.exitCode=exit.code;run.updatedAt=new Date().toISOString();
    const traceErrors=[...(Array.isArray(report?.steps)?report.steps:[]),...(Array.isArray(report?.decisions)?report.decisions:[])]
      .flatMap(item=>item&&typeof item==="object"&&typeof item.error==="string"?[redact(item.error)]:[]);
    for(const text of [...new Set(traceErrors)].slice(0,12))run.notes.push({at:run.updatedAt,text:`过程问题：${text.slice(0,2000)}`});
    if(run.status!=="finished"&&run.status!=="stopped")run.notes.push({at:run.updatedAt,text:`自动记录：${run.resultStatus??run.status} · ${run.error||"任务未获得成功证据"}`});
    await this.persist(run);this.children.delete(id);
  }
  async stop(id:string){return this.exclusive(async()=>{
    const run=this.get(id);if(!active(run))return structuredClone(run);
    if(run.status!=="stopping"){run.status="stopping";run.updatedAt=new Date().toISOString();await this.persist(run);this.children.get(id)?.stop();}
    return structuredClone(run);
  });}
  async note(id:string,text:string){return this.exclusive(async()=>{
    const run=this.get(id);if(!text.trim()||text.length>2000)throw new ConsoleError(400,"问题描述需为 1–2000 字");
    if(run.notes.length>=100)throw new ConsoleError(409,"This task already has 100 notes");
    run.notes.push({at:new Date().toISOString(),text:redact(text.trim())});await this.persist(run);return structuredClone(run);
  });}
  async shutdown(){this.closing=true;for(const id of this.children.keys())await this.stop(id);}
}

export function cliLauncher(repository:string):Launcher{return (input,reportPath,onOutput)=>{
  const args=["--import","tsx",join(repository,"agent/local-control/run-autonomous.ts"),"--device",input.deviceId,"--goal",input.goal,
    "--report",reportPath,"--max-decisions","20","--max-actions","64","--timeout-ms",input.mode==="execute"?"180000":"60000"];
  if(input.mode==="execute")args.push("--execute");
  // The child reads SCREENHAND_VISIBLE_INPUT; each input still needs current
  // keyboard geometry and exact field readback.
  const child=spawn(process.execPath,args,{cwd:repository,env:process.env,stdio:["ignore","pipe","pipe"],shell:false});
  child.stdout.on("data",chunk=>onOutput(chunk.toString()));child.stderr.on("data",chunk=>onOutput(chunk.toString()));
  const done=new Promise<{code:number|null;signal?:string|null}>((resolveDone,reject)=>{
    child.once("error",reject);child.once("close",(code,signal)=>{clearTimeout(deadline);resolveDone({code,signal});});
  });
  const stop=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGINT");};
  const deadline=setTimeout(stop,input.mode==="execute"?185_000:65_000);deadline.unref();
  return {stop,done};
};}
