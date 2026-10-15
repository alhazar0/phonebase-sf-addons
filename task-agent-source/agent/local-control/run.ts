import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import { ScreenHandGeneralAgentClient } from "../general-agent-client";
import { LocalPerceptionService } from "../local-perception/service";
import { warmVisionOcrDaemon, shutdownVisionOcrDaemon } from "../vision-ocr";
import { LocalClosedLoopExecutor } from "./executor";
import { requestSchema } from "./contract";

const {values}=parseArgs({options:{device:{type:"string"},request:{type:"string"},execute:{type:"boolean",default:false},report:{type:"string"}}});
if (!values.device || !/^[a-zA-Z0-9._-]{1,120}$/.test(values.device) || !values.request) throw new Error("Usage: npm run control:local -- --device ID --request JSON [--execute] [--report NEW_FILE.json]");
const request=requestSchema.parse(JSON.parse(values.request));
const base=process.env.SCREENHAND_API_URL ?? "http://127.0.0.1:3013";
const service=new LocalPerceptionService(base); // Validates loopback-only before any request.
const client=new ScreenHandGeneralAgentClient(values.device,base,15_000);
// Reserve the report before hardware work, so an existing/unwritable path cannot
// fail only after an action has already happened.
const reportFile=values.report ? await open(values.report,"wx",0o600) : null;
const abort=new AbortController();
const cancel=()=>abort.abort(new Error("Stopped by user; no further physical actions will be submitted"));
process.once("SIGINT",cancel); process.once("SIGTERM",cancel);
const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(45_000)]);
const wallStart=performance.now();
try {
  await warmVisionOcrDaemon();
  const runtime=new LocalClosedLoopExecutor({deviceId:values.device,
    observe:async s=>service.observe(values.device!,{freshOcr:true,signal:s}),
    getDevice:s=>client.getDevice(s),getCalibration:s=>client.getCalibration(s),
    act:(action,s,key)=>client.executeAction(action,s,{idempotencyKey:key}),
  });
  const result=await runtime.run(request,{execute:values.execute,signal});
  const report={...result,cliElapsedMs:performance.now()-wallStart};
  const json=JSON.stringify(report,null,2);
  if(reportFile) await reportFile.writeFile(json+"\n");
  // Detailed camera evidence stays in the optional local report, not a huge log dump.
  console.log(JSON.stringify({id:report.id,status:report.status,error:report.error,action:report.action,actionSubmissionCount:report.actionSubmissionCount,
    timing:report.timing,cliElapsedMs:report.cliElapsedMs,before:report.before?.text,after:report.after?.text,
    receiptId:report.receipt?.id,verification:report.verification,verificationSamples:report.verificationSamples.length,reportFile:values.report ?? null},null,2));
  if (!["preview","verified","already_satisfied"].includes(result.status)) process.exitCode=1;
} finally {process.removeListener("SIGINT",cancel);process.removeListener("SIGTERM",cancel);await shutdownVisionOcrDaemon();await reportFile?.close();}
