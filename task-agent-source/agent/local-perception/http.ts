import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import { PerceptionUnavailable, type LocalPerceptionService } from "./service";
import { buildTextDocument, type TextSemanticAssistant } from "./text-semantics";

const requestSchema=z.object({deviceId:z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
  requestId:z.string().regex(/^[a-zA-Z0-9._:-]{1,120}$/)}).strict();
class HttpError extends Error {constructor(readonly status:number,message:string){super(message);}}
function requireLocal(request:IncomingMessage) {
  if(request.headers["sec-fetch-site"]==="cross-site" ||
    (request.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):(3011|3026)$/.test(request.headers.origin))) {
    throw new HttpError(403,"Text assistance is restricted to the local console");
  }
}
async function readRequest(request:IncomingMessage) {
  if(request.headers["content-type"]?.split(";",1)[0].trim()!=="application/json")throw new HttpError(415,"Use application/json");
  if(Number(request.headers["content-length"])>2048)throw new HttpError(413,"Request exceeds limit");
  const parts:Buffer[]=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>2048)throw new HttpError(413,"Request exceeds limit");parts.push(Buffer.from(chunk));}
  try{return requestSchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));}
  catch{throw new HttpError(400,"Expected only deviceId and requestId");}
}

/** No action dependency. GETs remain local even for old clients using semantic=1. */
export function createPerceptionServer(service:Pick<LocalPerceptionService,"devices"|"observe">,
  semantics:TextSemanticAssistant,warmup:Promise<unknown>=Promise.resolve()) {
  return createServer({requestTimeout:5000,headersTimeout:5000},async(request,response)=>{
    response.setHeader("Content-Type","application/json; charset=utf-8");
    response.setHeader("Cache-Control","no-store");response.setHeader("X-Content-Type-Options","nosniff");
    const reply=(status:number,body:unknown)=>{response.statusCode=status;response.end(JSON.stringify(body));};
    try {
      const url=new URL(request.url??"/","http://127.0.0.1:3026");
      if(request.method==="POST" && url.pathname==="/semantics") {
        requireLocal(request);
        const input=await readRequest(request);await warmup;
        const snapshot=await service.observe(input.deviceId,{freshOcr:true,signal:AbortSignal.timeout(5000)});
        const semantic=semantics.request(snapshot,input.requestId);
        return reply(200,{ok:true,deviceId:input.deviceId,semantic});
      }
      if(request.method!=="GET") {
        response.setHeader("Allow",url.pathname==="/semantics"?"POST":"GET");
        return reply(405,{ok:false,error:"Only explicit text inspection is supported; no physical actions"});
      }
      if(url.pathname==="/health")return reply(200,{ok:true,mode:semantics.enabled?"local-ocr+on-demand-text-semantics":"local-perception-only",
        model:semantics.model,generatedModelCalls:semantics.modelCalls,textSemanticsEnabled:semantics.enabled,
        semanticTrigger:"explicit-post-only",imageUploads:0,physicalActionsAllowed:false,trainedClassifier:false});
      if(url.pathname==="/devices")return reply(200,{ok:true,devices:await service.devices()});
      if(url.pathname==="/observation") {
        requireLocal(request);
        const deviceId=url.searchParams.get("deviceId")??"";
        if(!/^[a-zA-Z0-9._-]{1,120}$/.test(deviceId))throw new HttpError(400,"Select a valid device");
        await warmup;
        const snapshot=await service.observe(deviceId);
        return reply(200,{...snapshot,scene:buildTextDocument(snapshot),generatedModelCalls:semantics.modelCalls,semantic:semantics.observe(snapshot)});
      }
      if(url.pathname==="/semantics"){response.setHeader("Allow","POST");return reply(405,{ok:false,error:"Use an explicit POST to request text interpretation"});}
      return reply(404,{ok:false,error:"Not found"});
    } catch(error) {
      const status=error instanceof HttpError?error.status:error instanceof PerceptionUnavailable?503:500;
      reply(status,{ok:false,error:status===500?"Local observation unavailable":(error as Error).message});
    }
  });
}
