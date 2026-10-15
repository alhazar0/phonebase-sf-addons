/** Development-only contact diagnostic; never an autonomous acceptance run. */
import {parseArgs} from "node:util";
import {mkdtemp,writeFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {randomUUID} from "node:crypto";
import {ScreenHandGeneralAgentClient} from "../general-agent-client";
import {LocalPerceptionService,readFrameHeader} from "../local-perception/service";
import {warmVisionOcrDaemon,shutdownVisionOcrDaemon} from "../vision-ocr";
import {selectAction} from "./executor";
import {normalTouchPressure} from "./touch-policy";
import {touchZForPressure} from "../../app/touch-pressure";
const {values}=parseArgs({options:{device:{type:"string"},text:{type:"string"},"normal-pressure":{type:"boolean",default:false},"firm-pressure":{type:"boolean",default:false},"duration-ms":{type:"string",default:"120"}}});
if(!values.device||!values.text)throw new Error("Use --device ID --text EXACT_VISIBLE_LABEL [--duration-ms 120]");
const duration=Number(values["duration-ms"]);if(!Number.isInteger(duration)||duration<40||duration>250)throw new Error("Probe duration must be 40–250 ms");
const abort=new AbortController(),stop=()=>abort.abort(new Error("Stopped"));process.once("SIGINT",stop);process.once("SIGTERM",stop);
const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]),directory=await mkdtemp(".runtime/touch-probe-");
try {
  const base="http://127.0.0.1:3013",client=new ScreenHandGeneralAgentClient(values.device,base,10000),service=new LocalPerceptionService(base);
  await warmVisionOcrDaemon(signal);const profile=await client.getCalibration(signal);if(!profile)throw new Error("No calibration");
  const before=await service.observe(values.device,{freshOcr:true,signal});
  const device=await client.getDevice(signal);if(!device.connected||!device.state?.grbl?.homed||device.state.grbl.state!=="Idle"||device.state.grbl.activeOperation||device.state.grbl.liveTouch)throw new Error("Device not idle");
  let action=selectAction({type:"tap_text",text:values.text},before,profile);if(action.type!=="tap")throw new Error("Expected tap");action.durationMs=duration;
  if(values["normal-pressure"])action=normalTouchPressure(action,device);
  if(values["firm-pressure"]){
    if(values["normal-pressure"])throw new Error("Choose one preset");
    const p=device.state?.grbl?.tapProfile;if(typeof p?.minimumTouchZ!=="number"||typeof p.maximumTouchZ!=="number")throw new Error("No advertised touch range");
    const touchZ=touchZForPressure("firm",{minimum:p.minimumTouchZ,maximum:p.maximumTouchZ});if(touchZ===null||action.type!=="tap")throw new Error("Invalid touch range");action={...action,touchZ};
  }
  const frames:Array<{file:string;sequence:number;at:number}>=[],started=Date.now();
  const capture=(async()=>{for(let i=0;i<25&&!signal.aborted;i++){
    const response=await fetch(`${base}/api/v1/devices/${encodeURIComponent(values.device!)}/screenshot`,{signal,cache:"no-store"});
    if(!response.ok)throw new Error(`Screenshot HTTP ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer()),sequence=readFrameHeader(response,"frame-sequence");
    const file=`${directory}/${i}-${sequence}.jpg`;await writeFile(file,bytes,{flag:"wx",mode:0o600});frames.push({file,sequence,at:Date.now()-started});await delay(100,undefined,{signal});
  }})();
  const key=`probe-${randomUUID()}`;
  await writeFile(`${directory}/intent.json`,JSON.stringify({key,action}),{flag:"wx",mode:0o600});
  let result;try{result=await client.executeAction(action,signal,{idempotencyKey:key});}finally{await capture;}
  await writeFile(`${directory}/result.json`,JSON.stringify({action,result,frames},null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({directory,receipt:result.receipt,frames},null,2));
}finally{process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);await shutdownVisionOcrDaemon();}
