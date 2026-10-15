import dotenv from "dotenv";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ScreenHandGeneralAgentClient} from "../general-agent-client";
import {LocalPerceptionService} from "../local-perception/service";
import {plannerSettings} from "../local-control/planner-factory";
import {TaskConsoleManager,cliLauncher,ConsoleError} from "./manager";
import {createTaskConsoleServer,type ConsoleDevice} from "./http";
import {readTouchAlignment,alignedCalibration} from "../local-control/touch-alignment";
dotenv.config({quiet:true});
const repository=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const port=Number(process.env.SCREENHAND_TASK_CONSOLE_PORT??3027);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("Invalid task console port");
const base=process.env.SCREENHAND_API_URL??"http://127.0.0.1:3013";
const perception=new LocalPerceptionService(base); // Validates loopback-only.
const settings=plannerSettings(),plannerConfigured=settings.configured;
const devices=async():Promise<ConsoleDevice[]>=>Promise.all((await perception.devices()).map(async listed=>{
  if(!listed.connected)return {...listed,homed:false,ready:false,reason:"设备未连接"};
  const client=new ScreenHandGeneralAgentClient(listed.id,base);
  const device=await client.getDevice(AbortSignal.timeout(2500));
  const homed=!!device.state?.grbl?.homed;
  const ready=homed&&device.state?.grbl?.state==="Idle"&&!device.state.grbl.activeOperation&&!device.state.grbl.liveTouch&&!!device.screen&&!!device.capabilities.actions.tap?.available;
  if(ready)try{
    const alignment=await readTouchAlignment(device.id);
    if(!alignedCalibration(await client.getCalibration(AbortSignal.timeout(2500)),alignment))throw new Error("Missing verified calibration");
  }catch(error){return {id:device.id,connected:device.connected,homed,ready:false,reason:`点击标定未就绪：${error instanceof Error?error.message:"无法验证"}`};}
  return {id:device.id,connected:device.connected,homed,ready,reason:ready?undefined:!homed?"机械臂尚未归零":device.capabilities.actions.tap?.reason??"设备忙碌、标定未就绪或摄像头未连接"};
}));
const manager=new TaskConsoleManager(resolve(repository,".runtime/task-console"),cliLauncher(repository),async input=>{
  if(!plannerConfigured)throw new ConsoleError(503,"未配置模型连接；密钥只在本机服务端设置。");
  const device=(await devices()).find(d=>d.id===input.deviceId);
  if(!device?.connected)throw new ConsoleError(409,"所选设备未连接。");
  if(input.mode==="execute"&&!device.ready)throw new ConsoleError(409,device.reason??"设备未就绪。");
});
await manager.initialize();
const server=createTaskConsoleServer(manager,{devices,plannerConfigured,visibleTextEntry:process.env.SCREENHAND_VISIBLE_INPUT==="1"&&process.platform==="darwin",model:`${settings.provider}/${settings.model}`,plannerInput:settings.provider==="codex"?"screenshot+ocr":"ocr-layout",
  frame:async id=>{
    const response=await fetch(new URL(`/api/v1/devices/${encodeURIComponent(id)}/screenshot`,base),{signal:AbortSignal.timeout(2500),cache:"no-store",redirect:"error"});
    if(!response.ok)throw new ConsoleError(503,"摄像头暂不可用");
    if(Number(response.headers.get("content-length"))>8_000_000){await response.body?.cancel();throw new ConsoleError(413,"Camera image too large");}
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>8_000_000||bytes[0]!==255||bytes[1]!==216)throw new ConsoleError(502,"Invalid camera JPEG");return bytes;
  },
});
server.listen(port,"127.0.0.1",()=>console.log(`[task-console] http://127.0.0.1:${port}; durable logs .runtime/task-console; field input ${process.env.SCREENHAND_VISIBLE_INPUT==="1"?"enabled":"disabled"}`));
let stopping=false;
for(const name of ["SIGINT","SIGTERM"] as const)process.on(name,()=>{
  if(stopping)return;stopping=true;server.close();
  void manager.shutdown().then(()=>{setTimeout(()=>{server.closeAllConnections();process.exit(0);},6000).unref();});
});
