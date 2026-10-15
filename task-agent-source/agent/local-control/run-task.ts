import { parseArgs } from "node:util";
import { open,mkdtemp,writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { ScreenHandGeneralAgentClient } from "../general-agent-client";
import { LocalPerceptionService } from "../local-perception/service";
import { warmVisionOcrDaemon, shutdownVisionOcrDaemon } from "../vision-ocr";
import { TextTaskPlanner } from "./task-planner";
import { LocalVisualTaskRunner } from "./task-runner";
import { actionContextReader } from "../local-perception/action-context";
import { dirname } from "node:path";
import { readResponseHints } from "./result-history";

dotenv.config({quiet:true});
const {values}=parseArgs({options:{device:{type:"string"},goal:{type:"string"},report:{type:"string"},execute:{type:"boolean",default:false}}});
if(!values.device||!/^[a-zA-Z0-9._-]{1,120}$/.test(values.device)||!values.goal||!values.report)throw new Error("Use --device ID --goal TEXT --report NEW_FILE [--execute]");
const file=await open(values.report,"wx",0o600);const start=performance.now();
const abort=new AbortController(),stop=()=>abort.abort(new Error("Stopped; no further actions"));
process.once("SIGINT",stop);process.once("SIGTERM",stop);
const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(45000)]);
try {
  const evidenceDirectory=await mkdtemp(`${values.report}.frames-`);
  const evidenceFrames:Array<{sequence:number;capturedAt:number;file:string}>=[];const saved=new Set<number>();let evidenceBytes=0;
  const base=process.env.SCREENHAND_API_URL??"http://127.0.0.1:3013";
  const service=new LocalPerceptionService(base,undefined,undefined,actionContextReader(base)),client=new ScreenHandGeneralAgentClient(values.device,base,15000);
  const planner=new TextTaskPlanner(process.env.OPENROUTER_API_KEY??"",fetch,(deviceId,fingerprint)=>readResponseHints(dirname(values.report!),deviceId,fingerprint));
  await warmVisionOcrDaemon(signal);const warmupMs=performance.now()-start;
  const runtime=new LocalVisualTaskRunner({deviceId:values.device,observe:async s=>{
    const view=await service.observe(values.device!,{freshOcr:true,signal:s});
    if(!saved.has(view.frame.sequence)&&evidenceFrames.length<96&&evidenceBytes<20_000_000) {
      const path=`${evidenceDirectory}/${view.frame.sequence}.jpg`,bytes=Buffer.from(view.frame.image.slice("data:image/jpeg;base64,".length),"base64");
      if(evidenceBytes+bytes.length<=20_000_000) {
        await writeFile(path,bytes,{flag:"wx",mode:0o600});saved.add(view.frame.sequence);evidenceBytes+=bytes.length;
        evidenceFrames.push({sequence:view.frame.sequence,capturedAt:view.frame.capturedAt,file:path});
      }
    }
    return view;
  },
    getDevice:s=>client.getDevice(s),getCalibration:s=>client.getCalibration(s),act:(a,s,key)=>client.executeAction(a,s,{idempotencyKey:key})},planner);
  const report=await runtime.run(values.goal,{execute:values.execute,signal,checkpoint:async r=>{
    const bytes=Buffer.from(JSON.stringify({...r,warmupMs,cliElapsedMs:performance.now()-start,evidence:{directory:evidenceDirectory,frames:evidenceFrames,bytes:evidenceBytes,maximumFrames:96,maximumBytes:20_000_000}},null,2));
    await file.write(bytes,0,bytes.length,0);await file.truncate(bytes.length);await file.sync();
  }});
  console.log(JSON.stringify({status:report.status,error:report.error,modelCalls:report.modelCalls,imageUploads:0,terminalInterventions:0,
    timing:report.timing,warmupMs,cliElapsedMs:performance.now()-start,plan:report.plan,resultEvidence:report.resultEvidence,responseHints:report.responseHints,
    steps:report.steps.map(s=>({status:s.status,action:s.action,error:s.error,timing:s.timing,receipt:s.receipt?.id,imageProof:s.after?.imageProof,readback:s.after?.readback})),cleanup:report.cleanup?.status,report:values.report,evidenceDirectory},null,2));
  if(!["verified","preview"].includes(report.status))process.exitCode=1;
}finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);await shutdownVisionOcrDaemon();await file.close();}
