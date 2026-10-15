import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import { ScreenHandGeneralAgentClient } from "../general-agent-client";
import { LocalPerceptionService } from "../local-perception/service";
import { warmVisionOcrDaemon,shutdownVisionOcrDaemon } from "../vision-ocr";
import { readVisibleKeyboard,typeVisibleText } from "./visible-keyboard";
import {fillVisibleField} from "./field-entry";
const {values}=parseArgs({options:{device:{type:"string"},text:{type:"string"},field:{type:"string"},report:{type:"string"},execute:{type:"boolean",default:false}}});
if(!values.device||!values.text||!values.report)throw new Error("Use --device ID --text TEXT --report NEW_FILE [--execute]");
const file=await open(values.report,"wx",0o600),abort=new AbortController(),stop=()=>abort.abort(new Error("Stopped"));
process.once("SIGINT",stop);process.once("SIGTERM",stop);
const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(180_000)]);
try {
  const base=process.env.SCREENHAND_API_URL??"http://127.0.0.1:3013",client=new ScreenHandGeneralAgentClient(values.device,base,15000),service=new LocalPerceptionService(base);
  const deps={deviceId:values.device,observe:(s:AbortSignal)=>service.observe(values.device!,{freshOcr:true,signal:s}),getDevice:(s:AbortSignal)=>client.getDevice(s),getCalibration:(s:AbortSignal)=>client.getCalibration(s),
    act:(a:Parameters<typeof client.executeAction>[0],s:AbortSignal,key:string)=>client.executeAction(a,s,{idempotencyKey:key})};
  await warmVisionOcrDaemon(signal);
  const before=await deps.observe(signal),profile=await deps.getCalibration(signal);if(!profile)throw new Error("No verified calibration");
  if(values.execute&&values.field){
    const result=await fillVisibleField(deps,values.field,values.text,signal);
    await file.writeFile(JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
    if(result.status!=="verified")process.exitCode=1;
  }else{
  const layout=await readVisibleKeyboard(before,profile,signal);
  if(!values.execute){const report={status:"preview",mode:layout.mode,uppercase:layout.uppercase,anchors:layout.anchors,keys:layout.keys};await file.writeFile(JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
  else {
    const result=await typeVisibleText(deps,values.text,signal),after=await deps.observe(signal);
    await file.writeFile(JSON.stringify({...result,before:{sequence:before.frame.sequence,text:before.elements},after:{sequence:after.frame.sequence,text:after.elements}},null,2));
    console.log(JSON.stringify({...result,afterText:after.elements.filter(e=>e.center.y<layout.top-25).map(e=>e.text)},null,2));
    if(result.status!=="typed_unverified")process.exitCode=1;
  }
  }
}finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);await shutdownVisionOcrDaemon();await file.close();}
