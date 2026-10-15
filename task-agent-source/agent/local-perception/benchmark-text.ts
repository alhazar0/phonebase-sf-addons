import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import dotenv from "dotenv";
import { LocalPerceptionService } from "./service";
import { buildTextDocument, OpenRouterTextClassifier } from "./text-semantics";
import { shutdownVisionOcrDaemon } from "../vision-ocr";

dotenv.config({quiet:true});
const {values}=parseArgs({options:{device:{type:"string"},runs:{type:"string",default:"3"},report:{type:"string"}}});
const runs=Number(values.runs);
if(!values.device || !/^[\w.-]{1,120}$/.test(values.device) || !Number.isInteger(runs) || runs<1 || runs>5 || !values.report)throw new Error("Usage: --device ID --runs 1..5 --report NEW_FILE.json");
const classifier=new OpenRouterTextClassifier({apiKey:process.env.OPENROUTER_API_KEY ?? "",model:process.env.SCREENHAND_TEXT_SEMANTICS_MODEL,timeoutMs:2500});
const service=new LocalPerceptionService(process.env.SCREENHAND_API_URL ?? "http://127.0.0.1:3013");
const file=await open(values.report,"wx",0o600);
const controller=new AbortController();const stop=()=>controller.abort();
process.once("SIGINT",stop);process.once("SIGTERM",stop);
const samples:unknown[]=[];
try {
  for(let i=0;i<runs;i++) {
    controller.signal.throwIfAborted();const start=performance.now();
    const observation=await service.observe(values.device,{freshOcr:true,signal:controller.signal});
    const document=buildTextDocument(observation);const modelStart=performance.now();
    try {
      const result=await classifier.classify(document,controller.signal);
      const sample={sequence:observation.frame.sequence,localPage:observation.state.page,ocrMs:observation.timing.ocrMs,document,modelMs:performance.now()-modelStart,totalMs:performance.now()-start,result};
      samples.push(sample);console.log(JSON.stringify({...sample,document:undefined}));
    } catch(error) {
      const sample={sequence:observation.frame.sequence,modelMs:performance.now()-modelStart,error:error instanceof Error && /^Text model HTTP \d+$/.test(error.message)?error.message:"Inference failed or exceeded 2500 ms"};
      samples.push(sample);console.log(JSON.stringify(sample));process.exitCode=1;
    }
  }
} finally {
  process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);
  await file.writeFile(JSON.stringify({mode:"text-only-read-only-benchmark",model:classifier.model,physicalActions:0,imageUploads:0,samples},null,2)+"\n");
  await file.close();await shutdownVisionOcrDaemon();
}
