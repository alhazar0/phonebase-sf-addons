import {createServer,type IncomingMessage} from "node:http";
import {z} from "zod";
import {ConsoleError,redact,type TaskConsoleManager} from "./manager";
export type ConsoleDevice={id:string;connected:boolean;homed:boolean;ready:boolean;reason?:string};
type Services={devices:()=>Promise<ConsoleDevice[]>;frame:(id:string)=>Promise<Buffer>;model:string;plannerConfigured:boolean;plannerInput?:"ocr-layout"|"screenshot+ocr";visibleTextEntry?:boolean};
async function body(request:IncomingMessage){
  if(request.headers["content-type"]?.split(";",1)[0].trim()!=="application/json")throw new ConsoleError(415,"Use application/json");
  if(Number(request.headers["content-length"])>8192)throw new ConsoleError(413,"Request too large");
  const parts:Buffer[]=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>8192)throw new ConsoleError(413,"Request too large");parts.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(parts).toString("utf8"));}catch{throw new ConsoleError(400,"Invalid JSON");}
}
function localOnly(request:IncomingMessage,port:number){
  const host=request.headers.host??"",allowedPorts=[3011,port];
  if(!allowedPorts.some(p=>host===`127.0.0.1:${p}`||host===`localhost:${p}`))throw new ConsoleError(403,"Local console only");
  const origin=request.headers.origin;
  if(request.headers["sec-fetch-site"]==="cross-site"||(origin&&!allowedPorts.some(p=>origin===`http://127.0.0.1:${p}`||origin===`http://localhost:${p}`)))throw new ConsoleError(403,"Local console only");
}
export function createTaskConsoleServer(manager:TaskConsoleManager,services:Services){
  const server=createServer({requestTimeout:10000,headersTimeout:5000},async(request,response)=>{
    response.setHeader("Cache-Control","no-store");response.setHeader("X-Content-Type-Options","nosniff");response.setHeader("Content-Type","application/json; charset=utf-8");
    const reply=(status:number,data:unknown)=>{response.statusCode=status;response.end(JSON.stringify(data));};
    try{
      const address=server.address();localOnly(request,typeof address==="object"&&address?address.port:3027);
      const url=new URL(request.url??"/","http://127.0.0.1:3027");
      if(request.method==="GET"){
        if(url.pathname==="/health")return reply(200,{ok:true,model:services.model,plannerInput:services.plannerInput??"ocr-layout",plannerConfigured:services.plannerConfigured,visibleTextEntry:services.visibleTextEntry??false,capabilities:{navigation:true,observedControls:true,fieldInput:services.visibleTextEntry??false,textAlphabet:"printable ASCII",messageSubmission:"bound draft and new outgoing bubble; delivery unverified",multiTouch:false},execution:"autonomous-local-control",logsPersistent:true});
        if(url.pathname==="/devices")return reply(200,{ok:true,devices:await services.devices()});
        if(url.pathname==="/runs")return reply(200,{ok:true,runs:manager.list()});
        const frame=url.pathname.match(/^\/devices\/([a-zA-Z0-9_-]{1,80})\/frame$/);
        if(frame){const bytes=await services.frame(frame[1]);response.setHeader("Content-Type","image/jpeg");response.end(bytes);return;}
        const run=url.pathname.match(/^\/runs\/([a-f0-9-]{36})(\/report)?$/i);
        if(run){const detail=await manager.detail(run[1]);
          if(run[2])response.setHeader("Content-Disposition",`attachment; filename="screenhand-${run[1]}.json"`);
          return reply(200,{ok:true,...detail});}
        return reply(404,{ok:false,error:"Not found"});
      }
      if(request.method==="POST"){
        if(url.pathname==="/runs")return reply(202,{ok:true,run:await manager.start(await body(request))});
        const run=url.pathname.match(/^\/runs\/([a-f0-9-]{36})\/(stop|notes)$/i);
        if(run){const input=await body(request);
          if(run[2]==="stop"){z.object({}).strict().parse(input);return reply(200,{ok:true,run:await manager.stop(run[1])});}
          const note=z.object({text:z.string().min(1).max(2000)}).strict().parse(input);return reply(200,{ok:true,run:await manager.note(run[1],note.text)});
        }
        return reply(404,{ok:false,error:"Not found"});
      }
      response.setHeader("Allow","GET, POST");return reply(405,{ok:false,error:"Unsupported method"});
    }catch(error){const status=error instanceof ConsoleError?error.status:error instanceof z.ZodError?400:500;
      if(status===500)console.error("[task-console]",redact(error instanceof Error?error.stack??error.message:String(error)));
      reply(status,{ok:false,error:status===500?"任务服务暂时不可用，请查看本地服务日志。":error instanceof z.ZodError?"Invalid task request":redact((error as Error).message)});
    }
  });return server;
}
