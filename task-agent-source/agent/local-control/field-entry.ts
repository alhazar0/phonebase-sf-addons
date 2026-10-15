import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import sharp from "sharp";
import {calibratedScreenPoint, type ScreenHandCalibrationProfile} from "../calibration-profile";
import {recognizeVisionText} from "../vision-ocr";
import {requireFreshFrame} from "../local-perception/service";
import {calibrationFingerprint, type ControlDependencies, type LocalView} from "./executor";
import {cameraToScreen, validateGeometry} from "./geometry";
import {readVisibleKeyboard, typeVisibleText, keyboardContentBoundary,type TextEntryReport} from "./visible-keyboard";
import {readShortFieldEvidence} from './short-text-ocr';
import {reconcileField,type FieldSnapshot,type InputResolution} from './input-state';
import {inspectFieldSnapshot,type PixelBox} from './field-vision';
import {systemSearchResultTarget} from './search-dismissal';
import {regionContains,type CameraRegion} from './interaction';

type Region = {left:number;top:number;width:number;height:number};
export type FieldBinding = {label:string;region:Region;sourceSequence:number;calibrationFingerprint:string};
export type FieldRead = {sequence:number;capturedAt:number;text:string;expected:string;matched:boolean;snapshot?:FieldSnapshot;textBounds?:PixelBox};
export type FieldEntryReport = {
  status:"running"|"verified"|"blocked"|"action_uncertain"|"result_available";
  field:string;value:string;elapsedMs:number;error?:string;binding?:FieldBinding;
  focusReceiptId?:string;typing?:TextEntryReport;reads:FieldRead[];
  resolution?:InputResolution;confirmedPrefix?:string;submittedPrefix?:string;recovery?:"reobserve"|"replan"|"stop";operations?:Array<{kind:string;receiptId?:string;status:string}>;
};
const norm = (s:string)=>s.normalize("NFKC").trim().replace(/\s+/g," ");
const fieldLabel=(s:string)=>norm(s).replace(/\s*([•·])\s*/g,"$1").replace(/^\|\s*(?=[A-Za-z])/,"").replace(/(:)\s*\|$/,"$1");
const fieldAnchorMatches=(actual:string,label:string)=>fieldLabel(actual).toLowerCase()===fieldLabel(label).toLowerCase()||/:$/.test(label)&&fieldLabel(actual).toLowerCase().startsWith(fieldLabel(label).toLowerCase());
function fieldTargets(view:LocalView,label:string,bottom:number,region?:CameraRegion){
  const eligible=view.elements.filter(e=>e.confidence>=.65&&e.bounds.top+e.bounds.height<bottom&&(!region||regionContains(region,e,view)));
  const exact=eligible.filter(e=>fieldLabel(e.text)===fieldLabel(label));
  if(exact.length)return exact;
  const named=eligible.filter(e=>fieldAnchorMatches(e.text,label));
  return named.length?named:region&&eligible.length===1&&eligible[0].confidence>=.9?eligible:[];
}

/** Field-local comparison, not a substring found somewhere on the page.
 * Phone punctuation may change, but digits/case/content may not. */
export function fieldValueMatches(actual:string,expected:string,label=""):boolean {
  let text=norm(actual);
  if(expected===label)return fieldLabel(text).toLowerCase()===fieldLabel(expected).toLowerCase();
  // Vision can read a leading magnifying-glass glyph as Q. Only tolerate that
  // same prefix when it was part of the bound placeholder, never arbitrary text.
  if(expected!==label&&/^Q\s/.test(label)&&/^Q\s/.test(text))text=text.slice(2).trim();
  // Persistent field labels such as "To:" remain beside the entered value.
  // Strip only the exact bound label, never an arbitrary word or suggestion.
  if(expected!==label&&/:$/.test(label)&&text.toLowerCase().startsWith(norm(label).toLowerCase()))text=text.slice(norm(label).length).trim();
  if(/^\d+$/.test(expected))return /^[\d\s()+-]+$/.test(text)&&text.replace(/[\s()+-]/g,"")===expected;
  return text===expected;
}

export function bindVisibleField(view:LocalView,profile:ScreenHandCalibrationProfile,label:string,keyboardTop:number,region?:CameraRegion):FieldBinding {
  validateGeometry(profile,view);requireFreshFrame(view.frame.capturedAt);
  const matches=fieldTargets(view,label,keyboardTop,region);
  if(matches.length!==1)throw new Error("Field label must be unique in the current frame");
  const target=matches[0],point=cameraToScreen(profile,target.center);
  if(target.bounds.top+target.bounds.height>=keyboardTop-8||point.y<profile.screen.height*.05)throw new Error("Field must be above, not inside, the keyboard");
  const pad=Math.max(4,Math.ceil(target.bounds.height*.5));
  const left=Math.max(0,Math.floor(target.bounds.left-3));
  const rowEnd=view.elements.filter(e=>e.id!==target.id&&e.confidence>=.65&&e.bounds.left>=target.bounds.left+target.bounds.width+target.bounds.height*.8&&Math.abs(e.center.y-target.center.y)<target.bounds.height*.65).map(e=>e.bounds.left-6);
  rowEnd.push(...(view.affordances??[]).filter(a=>a.confidence>=.8&&a.bounds.left>=target.bounds.left+target.bounds.width+target.bounds.height*.8&&Math.abs(a.center.y-target.center.y)<Math.max(target.bounds.height,a.bounds.height)*.65).map(a=>a.bounds.left-6));
  const right=Math.min(view.frame.width,Math.floor(Math.min(profile.imagePoints[1].x,profile.imagePoints[2].x)-4),...rowEnd.map(Math.floor));
  const top=Math.max(0,Math.floor(target.bounds.top-pad));
  const bottom=Math.min(keyboardTop-8,Math.ceil(target.bounds.top+target.bounds.height+pad));
  if(right-left<target.bounds.width||bottom<=top)throw new Error("Field readback region is invalid");
  // Never allow another row of form data or a suggestion strip into this ROI.
  if(view.elements.some(e=>e.id!==target.id&&e.confidence>=.65&&e.bounds.left>=left&&e.bounds.left<right&&e.bounds.top<bottom&&e.bounds.top+e.bounds.height>top))throw new Error("Field row contains ambiguous neighbouring text");
  return {label:region&&!/[:：]$/.test(label)?fieldLabel(target.text):label,region:{left,top,width:right-left,height:bottom-top},sourceSequence:view.frame.sequence,calibrationFingerprint:calibrationFingerprint(profile)};
}

export async function readBoundField(view:LocalView,binding:FieldBinding,expected:string,signal:AbortSignal):Promise<FieldRead> {
  signal.throwIfAborted();requireFreshFrame(view.frame.capturedAt);
  if(view.state.overlay!=="none"||view.timing.ocrCacheHit||view.timing.ocrCapturedAt!==view.frame.capturedAt)throw new Error("Field readback needs fresh unobstructed camera evidence");
  const region={...binding.region};
  // A newly enabled trailing control (for example a submit icon) is not field
  // text. Clip only a currently observed separate component to the right.
  const end=(view.affordances??[]).filter(a=>a.confidence>=.8&&a.bounds.width<region.width*.2&&a.bounds.left>region.left+region.width*.6&&Math.abs(a.center.y-(region.top+region.height/2))<region.height*.6).map(a=>Math.floor(a.bounds.left-5));
  if(end.length)region.width=Math.min(region.width,Math.min(...end)-region.left);
  const bytes=await sharp(Buffer.from(view.frame.image.split(",")[1],"base64"))
    .extract(region).resize({width:Math.min(1400,region.width*3)}).jpeg({quality:95}).toBuffer();
  const result=await recognizeVisionText(`data:image/jpeg;base64,${bytes.toString("base64")}`,signal,"literal");
  const items=result.items.filter(e=>e.confidence>=.65).sort((a,b)=>a.left-b.left);
  const fallback=items.length?null:await readShortFieldEvidence(bytes,signal);
  const text=items.map(e=>e.text).join(" ")||fallback?.text||"";
  const scale=region.width/result.imageWidth;
  const boxes=items.map(e=>({left:e.left,top:e.top,width:e.width,height:e.height}));if(fallback?.box)boxes.push(fallback.box);
  const left=boxes.length?Math.min(...boxes.map(b=>b.left)):0,top=boxes.length?Math.min(...boxes.map(b=>b.top)):0;
  const right=boxes.length?Math.max(...boxes.map(b=>b.left+b.width)):0,bottom=boxes.length?Math.max(...boxes.map(b=>b.top+b.height)):0;
  const textBounds=boxes.length?{left:region.left+left*scale,top:region.top+top*scale,width:(right-left)*scale,height:(bottom-top)*scale}:undefined;
  const confidence=items.length?Math.min(...items.map(e=>e.confidence)):fallback?.confidence??0;
  const snapshot=await inspectFieldSnapshot(view,region,binding.label,text,confidence,textBounds);
  return {sequence:view.frame.sequence,capturedAt:view.frame.capturedAt,text,expected,matched:fieldValueMatches(text,expected,binding.label),snapshot,textBounds};
}

/** Set a desired field value. Current field state, not the supplied label,
 * decides whether to focus, continue, replace a selection, or do nothing. */
export async function fillVisibleField(deps:ControlDependencies,field:string,value:string,signal:AbortSignal,
  progress?:(report:FieldEntryReport)=>Promise<void>,vision:{readKeyboard?:typeof readVisibleKeyboard;readField?:typeof readBoundField;purpose?:'query'|'form'|'recipient'|'message';prior?:FieldEntryReport;targetRegion?:CameraRegion}={}):Promise<FieldEntryReport> {
  field=fieldLabel(field);if(/^.{1,40}:/.test(field))field=field.slice(0,field.indexOf(':')+1);
  const start=performance.now(),report:FieldEntryReport={status:'running',field,value,elapsedMs:0,reads:[],operations:[]};
  const keyboardReader=vision.readKeyboard??readVisibleKeyboard,fieldReader=vision.readField??readBoundField;
  const save=async()=>{report.elapsedMs=performance.now()-start;await progress?.(report);};
  try {
    if(!field.trim()||field.length>120||!/^[\x20-\x7e]{1,120}$/.test(value)||value!==value.trim()||/ {2}/.test(value))throw new Error('Input requires 1–120 printable ASCII characters; leading/trailing or repeated spaces need a separate whitespace contract');
    const profile=await deps.getCalibration(signal);if(!profile)throw new Error('No verified calibration');
    const fingerprint=calibrationFingerprint(profile);
    let anchors:string[]=[];
    const ready=async()=>{
      const [v,d,p]=await Promise.all([deps.observe(signal),deps.getDevice(signal),deps.getCalibration(signal)]);
      if(!p||calibrationFingerprint(p)!==fingerprint)throw new Error('Calibration changed during field entry');
      validateGeometry(profile,v);requireFreshFrame(v.frame.capturedAt);
      if(v.deviceId!==deps.deviceId||d.id!==deps.deviceId||!d.connected||!d.state?.grbl?.homed||d.state.grbl.state!=='Idle'||d.state.grbl.activeOperation||d.state.grbl.liveTouch||!d.capabilities.actions.tap?.available)throw new Error('Field entry needs idle calibrated hardware');
      if(v.state.overlay!=='none'||v.timing.ocrCacheHit||v.timing.ocrCapturedAt!==v.frame.capturedAt)throw new Error('Field entry needs fresh unobstructed evidence');
      if(anchors.length>=2&&anchors.filter(t=>v.elements.some(e=>e.confidence>=.65&&fieldLabel(e.text)===t)).length<2&&!(vision.purpose==='query'&&systemSearchResultTarget(v,value)))throw new Error('Field page changed; old binding is invalid');
      return v;
    };
    const act=async(kind:string,v:LocalView,camera:{x:number;y:number},long=false)=>{
      const point=cameraToScreen(profile,camera);calibratedScreenPoint(profile,point);
      if(long&&!(await deps.getDevice(signal)).capabilities.actions.long_press?.available)throw new Error('Selection requires a supported long press');
      const record={kind,status:'submitting',receiptId:undefined as string|undefined};report.operations!.push(record);report.status='action_uncertain';await save();
      const r=await deps.act({type:long?'long_press':'tap',point,viewport:profile.screen,frameSequence:v.frame.sequence,durationMs:long?650:60},signal,`field-${kind}-${randomUUID()}`);
      record.receiptId=r.receipt.id;record.status=r.receipt.status;
      if(r.receipt.status!=='completed')throw new Error('Field action receipt uncertain; no replay');
      if(kind==='focus')report.focusReceiptId=r.receipt.id;
      report.status='running';await save();await delay(150,undefined,{signal});
    };
    let current=await ready(),keyboard:Awaited<ReturnType<typeof readVisibleKeyboard>>|undefined;
    const keyboardInitiallyVisible=current.state.keyboard;
    const findTargets=async()=>{
      if(current.state.keyboard)keyboard=await keyboardReader(current,profile,signal);
      const bottom=keyboard?keyboardContentBoundary(current,keyboard):current.frame.height;
      return fieldTargets(current,field,bottom,vision.targetRegion);
    };
    let targets=await findTargets();
    for(let n=0;n<3&&targets.length!==1;n++){await delay(150+n*31,undefined,{signal});current=await ready();targets=await findTargets();}
    if(targets.length!==1)throw new Error('Field anchor is missing or ambiguous; inspect a new field reference');
    anchors=current.elements.filter(e=>e.confidence>=.9&&e.id!==targets[0].id&&e.center.y<current.frame.height*.3&&e.text.length>2&&!/^[\d\W]+$/.test(e.text)).map(e=>fieldLabel(e.text)).slice(0,4);
    if(!current.state.keyboard){await act('focus',current,{x:Math.min(Math.min(profile.imagePoints[1].x,profile.imagePoints[2].x)-40,targets[0].bounds.left+targets[0].bounds.width+targets[0].bounds.height*.5),y:targets[0].center.y});current=await ready();}
    for(let n=0;n<4&&!report.binding;n++){
      try{keyboard=await keyboardReader(current,profile,signal);report.binding=bindVisibleField(current,profile,field,keyboardContentBoundary(current,keyboard),keyboardInitiallyVisible?vision.targetRegion:undefined);}
      catch(e){if(n===3)throw e;await delay(180+n*31,undefined,{signal});current=await ready();}
    }
    if(!report.binding)throw new Error('Field binding unavailable');const binding=report.binding;
    if(vision.prior?.status==='blocked'&&vision.prior.binding?.calibrationFingerprint===fingerprint&&vision.prior.submittedPrefix){
      const a=binding.region,b=vision.prior.binding.region,overlap=Math.max(0,Math.min(a.left+a.width,b.left+b.width)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.top+a.height,b.top+b.height)-Math.max(a.top,b.top));
      if(overlap/Math.min(a.width*a.height,b.width*b.height)>.7)report.submittedPrefix=vision.prior.submittedPrefix;
    }
    const observed:FieldSnapshot[]=[],focused=new Set<string>(),selected=new Set<string>();
    let replacements=0;
    const read=async(v:LocalView)=>{
      const r=await fieldReader(v,binding,value,signal);report.reads.push(r);
      if(r.snapshot)observed.push(r.snapshot);
      else observed.push({sequence:r.sequence,capturedAt:r.capturedAt,rawText:r.text,value:null,kind:'ambiguous',caret:'absent',selection:'none',confidence:0});
      report.resolution=reconcileField(value,observed,false,report.submittedPrefix);if(report.resolution.currentValue!==null&&value.startsWith(report.resolution.currentValue))report.confirmedPrefix=report.resolution.currentValue;
      await save();return r;
    };
    let latest=await read(current);
    for(let rounds=0;rounds<40;rounds++){
      let queryFirst:LocalView|null=null;
      for(let n=0;n<8;n++){
        current=await ready();latest=await read(current);
        if(vision.purpose==='query'&&systemSearchResultTarget(current,value)){
          if(queryFirst&&current.frame.sequence>queryFirst.frame.sequence){report.status='result_available';report.recovery='replan';return report;}queryFirst=current;
        }else queryFirst=null;
        if(report.resolution!.action!=='observe'&&!(vision.purpose==='query'&&queryFirst))break;
        await delay(130+n*41,undefined,{signal});
      }
      const resolution=report.resolution!;
      if(resolution.action==='done'){report.status='verified';report.recovery=undefined;return report;}
      if(resolution.action==='observe')throw new Error('Field state remains ambiguous after bounded fresh observations; no keys replayed');
      const b=latest.textBounds??binding.region;
      if(resolution.action==='focus_end'){
        const signature=JSON.stringify([resolution.currentValue,binding.region]);if(focused.has(signature))throw new Error('Caret did not reach the field end; choose another grounded edit route');focused.add(signature);
        const textEnd=b.left+b.width+Math.max(6,b.height*.5),fieldEnd=binding.region.left+binding.region.width-12;
        if(textEnd>=fieldEnd)throw new Error('No observed trailing field area to establish the insertion end');
        await act('focus',current,{x:(textEnd+fieldEnd)/2,y:b.top+b.height/2});
        observed.length=0;continue;
      }
      if(resolution.action==='select_all'){
        const signature=resolution.currentValue!;if(selected.has(signature)||replacements>=2)throw new Error('Selection did not establish the whole field; no repeated edit attempt');selected.add(signature);replacements++;
        await act('select',current,{x:b.left+b.width/2,y:b.top+b.height/2},true);
        current=await ready();const selection=await read(current);
        if(selection.snapshot?.selection!=='all'){
          const buttons=current.elements.filter(e=>e.confidence>=.9&&/^(select all|全选)$/i.test(e.text.trim()));
          if(buttons.length!==1)throw new Error('No unique Select All control; existing contents remain unchanged');
          await act('select_all',current,buttons[0].center);
        }
        observed.length=0;continue;
      }
      if(!['type_suffix','replace_selection'].includes(resolution.action))throw new Error(resolution.reason);
      const replacing=resolution.action==='replace_selection',prefix=replacing?'':resolution.currentValue??'';
      let end=Math.min(value.length,prefix.length+4);while(end>prefix.length+1&&value[end-1]===' ')end--;
      const chunk=value.slice(0,end),previousKeys=[...(report.typing?.keys??[])],previousMs=report.typing?.elapsedMs??0;
      const typing=await typeVisibleText({...deps,observe:async()=>ready()},chunk,signal,{initialPrefix:prefix,verifyEvery:4,readKeyboard:keyboardReader,yieldWhen:vision.purpose==='query'?v=>!!systemSearchResultTarget(v,value):undefined,
        verifyPrefix:async(v)=>{
          for(let n=0;n<6;n++){
            const r=await read(v),s=r.snapshot;
            if(s&&s.kind!=='ambiguous'&&(replacing?s.value===resolution.currentValue&&s.selection==='all':s.value===prefix&&s.caret!=='inside'&&s.selection==='none'))return v;
            await delay(140+n*29,undefined,{signal});v=await ready();
          }
          throw new Error('Field changed before the chunk; reconcile it before any further keys');
        },progress:async t=>{report.typing={...t,text:value,keys:[...previousKeys,...t.keys],elapsedMs:previousMs+t.elapsedMs};report.submittedPrefix=t.submittedPrefix;report.status=t.status==='action_uncertain'?'action_uncertain':'running';await save();}});
      report.typing={...typing,text:value,keys:[...previousKeys,...typing.keys],elapsedMs:previousMs+typing.elapsedMs};
      report.submittedPrefix=typing.submittedPrefix;
      if(typing.status==='action_uncertain'){report.status='action_uncertain';report.recovery='stop';throw new Error(typing.error??'Key receipt uncertain');}
      if(typing.status!=='typed_unverified'&&typing.status!=='yielded')throw new Error(typing.error??'Keyboard input paused for reconciliation');
      report.status='running';observed.length=0;await save();
    }
    throw new Error('Field reconciliation budget exhausted');
  }catch(error){if(report.status!=='action_uncertain')report.status='blocked';report.recovery=report.status==='action_uncertain'?'stop':'replan';report.error=error instanceof Error?error.message:String(error);}
  finally{await save();}
  return report;
}
