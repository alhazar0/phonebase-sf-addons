import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {parseArgs} from "node:util";
import sharp from "sharp";
import {ScreenObserver} from "../screen-observer";
import {LocalPageTracker} from "../local-perception/state";
import {detectVisualAffordances} from "../visual-affordance-detector";
import {catalogIconTarget} from "./navigation-grounding";
import {makeIconTemplate,matchIconTemplate,type IconTemplate} from "./icon-matcher";
import {iconLibrarySchema} from "./icon-library";
import {shutdownVisionOcrDaemon} from "../vision-ocr";
import type {LocalView} from "./executor";

// Read-only camera replay: never imports a device action client or planner.
const {values}=parseArgs({options:{report:{type:"string"},label:{type:"string"},output:{type:"string"},
  positive:{type:"string",multiple:true},negative:{type:"string",multiple:true}}});
if(!values.report||!values.label||!values.output)throw new Error("Use --report TASK_REPORT --label APP --output NEW_DIRECTORY --positive sequence,x,y [--negative sequence]");
const report=JSON.parse(await readFile(resolve(values.report),"utf8"));
const frames=report.evidence.frames as Array<{sequence:number;capturedAt:number;file:string}>;
const decisions=report.decisions.filter((d:{decision?:{step?:{operation:string;text:string}}})=>d.decision?.step?.operation==="open_app"&&d.decision.step.text===values.label);
if(decisions.length<2)throw new Error("Need two independent recorded labeled-app observations");
const step=report.steps.find((s:{request?:{intent?:{type:string;text:string}}})=>s.request?.intent?.type==="open_app"&&s.request.intent.text===values.label);
if(!step?.calibrationFingerprint)throw new Error("Missing recorded calibration fingerprint");
const templateFrames=[decisions[0].sourceSequence,decisions.at(-1).sourceSequence];
if(templateFrames[0]===templateFrames[1])throw new Error("Need independent template frames");
const observer=new ScreenObserver({ocrMode:"literal"});
async function sample(sequence:number){
  const f=frames.find(f=>f.sequence===sequence);if(!f)throw new Error(`Missing recorded frame ${sequence}`);
  const bytes=await readFile(f.file),info=await sharp(bytes).metadata();
  if(!info.width||!info.height)throw new Error("Invalid image");
  return {bytes,frame:{sequence,capturedAt:f.capturedAt,width:info.width,height:info.height}};
}
try{
  const templates:IconTemplate[]=[];
  for(const sequence of templateFrames){
    const {bytes,frame}=await sample(sequence);
    const observation=await observer.observe({...frame,bytes,mimeType:"image/jpeg"},undefined,{freshOcr:true});
    const affordances=(await detectVisualAffordances(bytes,{viewport:frame,sampleWidth:240,maximumCandidates:96})).candidates;
    const view={deviceId:report.deviceId,frame:{...frame,image:`data:image/jpeg;base64,${bytes.toString("base64")}`},elements:observation.elements,
      state:new LocalPageTracker().observe(observation),affordances} as LocalView;
    const labels=view.elements.filter(e=>e.text===values.label&&e.confidence>=.9);
    const icon=catalogIconTarget(view,values.label!);
    if(labels.length!==1||!icon)throw new Error("No unique high-confidence labeled catalog icon in the reference frame");
    templates.push(await makeIconTemplate(bytes,{label:values.label!,deviceId:report.deviceId,sourceSequence:sequence,frame:{width:frame.width,height:frame.height},bounds:icon.bounds}));
  }
  const agreement=templates[0].descriptor.reduce((s,x,i)=>s+x*templates[1].descriptor[i],0);
  if(agreement<.95)throw new Error("Independent labeled icon references disagree");
  const template=templates[1],cases=[];
  for(const item of [...(values.positive??[]).map(s=>({s,present:true})),...(values.negative??[]).map(s=>({s,present:false}))]){
    const [sequence,x,y]=item.s.split(",").map(Number);
    if(!Number.isSafeInteger(sequence)||item.present&&(!Number.isFinite(x)||!Number.isFinite(y)))throw new Error("Positive cases require sequence,x,y");
    if(templateFrames.includes(sequence))throw new Error("Evaluation frames must differ from template frames");
    const {bytes}=await sample(sequence),started=performance.now();
    const match=await matchIconTemplate(bytes,template,{deviceId:report.deviceId});
    const accepted=!!match&&!match.ambiguous;
    const hit=!!match&&Math.hypot(match.center.x-x,match.center.y-y)<Math.min(match.bounds.width,match.bounds.height)*.2;
    cases.push({sequence,expected:item.present?{x,y}:"absent",passed:item.present?accepted&&hit:!accepted,elapsedMs:performance.now()-started,match});
  }
  if(!cases.length)throw new Error("Supply independent positive and negative replay cases");
  const output=resolve(values.output);await mkdir(output,{recursive:false,mode:0o700});
  const library=iconLibrarySchema.parse({version:1,deviceId:report.deviceId,calibrationFingerprint:step.calibrationFingerprint,stage:"development",templates:[template]});
  const result={stage:"development-only camera replay",physicalActions:0,imageUploads:0,templateFrames,agreement,cases,
    passed:cases.every(c=>c.passed),notProven:["independent phones","physical touch accuracy","general icon recognition"]};
  await writeFile(join(output,"replay.json"),JSON.stringify(result,null,2),{flag:"wx",mode:0o600});
  if(result.passed)await writeFile(join(output,"icons.json"),JSON.stringify(library,null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({output,passed:result.passed,cases:cases.map(({sequence,passed,elapsedMs})=>({sequence,passed,elapsedMs}))},null,2));
  if(!result.passed)process.exitCode=1;
}finally{await shutdownVisionOcrDaemon();}
