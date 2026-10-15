import sharp from "sharp";
import { randomUUID } from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import { calibratedScreenPoint, type ScreenHandCalibrationProfile } from "../calibration-profile";
import { calibrationFingerprint, type ControlDependencies, type LocalView } from "./executor";
import { cameraToScreen, validateGeometry } from "./geometry";
import { requireFreshFrame } from "../local-perception/service";
import { recognizeVisionText } from "../vision-ocr";

type Point = { x: number; y: number };
export type VisibleKeyboard = {
  mode: "letters" | "digits" | "symbols";
  keys: Record<string, Point>;
  uppercase: boolean | null;
  top: number;
  pitch: number;
  anchors: number;
};
const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const median = (xs: number[]) => [...xs].sort((a,b) => a-b)[Math.floor(xs.length/2)];
const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/** Exclude observed predictions as well as keys from field targeting. A search
 * field may occupy the same height when the prediction strip is absent. */
export function keyboardContentBoundary(view:LocalView,keyboard:VisibleKeyboard){
  const candidates=view.elements.filter(e=>e.confidence>=.65&&e.center.y>keyboard.top-keyboard.pitch*1.7&&e.center.y<keyboard.top-keyboard.pitch*.55&&e.text.length>1);
  const row=candidates.filter(e=>candidates.some(other=>other.id!==e.id&&Math.abs(other.center.y-e.center.y)<keyboard.pitch*.3&&Math.abs(other.center.x-e.center.x)>keyboard.pitch*1.3));
  return row.length?Math.min(...row.map(e=>e.bounds.top))-keyboard.pitch*.15:keyboard.top-keyboard.pitch*.65;
}

function fit(points: Array<{ index: number; x: number; y: number }>) {
  const mx=points.reduce((s,p)=>s+p.index,0)/points.length, my=points.reduce((s,p)=>s+p.x,0)/points.length;
  const denominator=points.reduce((s,p)=>s+(p.index-mx)**2,0);
  if (!denominator) throw new Error("Keyboard row needs separated anchors");
  const pitch=points.reduce((s,p)=>s+(p.index-mx)*(p.x-my),0)/denominator;
  const left=my-pitch*mx, y=median(points.map(p=>p.y));
  if (points.some(p=>Math.abs(p.x-(left+pitch*p.index))>pitch*.16||Math.abs(p.y-y)>pitch*.3)) throw new Error("Keyboard anchors do not fit one regular row");
  return { left, y, pitch };
}

/** Current-frame QWERTY geometry plus visible key-cap evidence, never a stored
 * phone-size map. Unsupported/split keyboards stop instead of guessed typing. */
export async function readVisibleKeyboard(view: LocalView, profile: ScreenHandCalibrationProfile, signal?:AbortSignal, refined=false): Promise<VisibleKeyboard> {
  validateGeometry(profile,view); requireFreshFrame(view.frame.capturedAt);
  if (view.timing.ocrCacheHit||view.timing.ocrCapturedAt!==view.frame.capturedAt||view.state.overlay!=="none") throw new Error("Keyboard needs fresh unobstructed OCR");
  if(!refined) {
    // Reuse sufficient OCR from this current frame. Only do another local OCR
    // crop when the existing anchors cannot establish the keyboard geometry.
    try{return await readVisibleKeyboard(view,profile,signal,true);}catch{signal?.throwIfAborted();}
    // Never discard the mode controls just because a second OCR pass omitted
    // them. Crop the calibrated lower screen, not a window derived from "space".
    const left=Math.max(0,Math.floor(Math.min(...profile.imagePoints.map(p=>p.x))));
    const right=Math.min(view.frame.width,Math.ceil(Math.max(...profile.imagePoints.map(p=>p.x))));
    const screenTop=Math.min(...profile.imagePoints.map(p=>p.y)),bottom=Math.min(view.frame.height,Math.ceil(Math.max(...profile.imagePoints.map(p=>p.y))));
    const top=Math.max(0,Math.floor(screenTop+(bottom-screenTop)*.52)),height=bottom-top;
    {
      const crop=await sharp(Buffer.from(view.frame.image.split(",")[1],"base64")).extract({left,top,width:right-left,height}).resize({width:Math.min(1500,(right-left)*2)}).jpeg().toBuffer();
      const ocr=await recognizeVisionText(`data:image/jpeg;base64,${crop.toString("base64")}`,signal,"literal");
      const scale=(right-left)/ocr.imageWidth;
      const elements=ocr.items.map((e,i)=>({id:`keyboard-${i}`,role:"text" as const,text:e.text,confidence:e.confidence,
        center:{x:left+e.centerX*scale,y:top+e.centerY*scale},bounds:{left:left+e.left*scale,top:top+e.top*scale,width:e.width*scale,height:e.height*scale}}));
      const merged=[...elements,...view.elements.filter(old=>!elements.some(e=>Math.abs(e.center.x-old.center.x)<Math.max(10,e.bounds.width*.6)&&Math.abs(e.center.y-old.center.y)<Math.max(8,e.bounds.height*.6)))];
      return readVisibleKeyboard({...view,elements:merged},profile,signal,true);
    }
  }
  const candidates=view.elements.filter(e=>e.confidence>=.65).filter(e=>{
    try { return cameraToScreen(profile,e.center).y>profile.screen.height*.5; } catch { return false; }
  });
  const exact=(text:string)=>candidates.filter(e=>norm(e.text)===text);
  const keys: Record<string,Point>={};
  for(const key of ["space","123","abc","#+="]) { const matches=exact(key); if(matches.length===1)keys[key]=matches[0].center; }
  for(const item of candidates){const k=item.text.trim();if(/^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/.test(k)&&candidates.filter(e=>e.text.trim()===k).length===1)keys[k]=item.center;}
  const letters=candidates.filter(e=>/^[a-z]$/i.test(e.text.trim()));
  const digits=candidates.flatMap(e=>/^[0-9]$/.test(e.text.trim())?[e]:/^0\s*\+$/.test(e.text.trim())?[{...e,text:"0"}]:[]);
  if (letters.length<8&&digits.length>=8) {
    for(const digit of "0123456789") { const found=digits.filter(e=>e.text.trim()===digit); if(found.length===1)keys[digit]=found[0].center; }
    if(Object.keys(keys).filter(k=>/^\d$/.test(k)).length<8)throw new Error("Numeric keyboard labels are ambiguous");
    // A visible 1..0 number row has the same regular key geometry as QWERTY.
    // Recover an OCR-missed glyph only when observed anchors fit AND its key
    // background is supported by current pixels; never use stored coordinates.
    const ys=digits.map(e=>e.center.y);
    if(Math.max(...ys)-Math.min(...ys)<view.frame.width*.03){
      const row=fit(digits.map(e=>({index:'1234567890'.indexOf(e.text.trim()),...e.center})));
      if(row.pitch>view.frame.width*.025&&row.pitch<view.frame.width*.12){
        const {data,info}=await sharp(Buffer.from(view.frame.image.split(',')[1],'base64')).grayscale().raw().toBuffer({resolveWithObject:true});
        for(const [i,key] of [...'1234567890'].entries())if(!keys[key]){
          const x=Math.round(row.left+row.pitch*i),y=Math.round(row.y-row.pitch*.3),gap=Math.round(x-row.pitch*.5);
          if(x>0&&gap>0&&x<info.width&&y>0&&y<info.height&&Math.abs(data[y*info.width+x]-data[y*info.width+gap])>=10)keys[key]={x:row.left+row.pitch*i,y:row.y};
        }
      }
    }
    else if(!keys['0']){
      const nine=digits.filter(e=>e.text!=='0');
      const rows=[0,1,2].map(row=>nine.filter(e=>Math.floor((Number(e.text)-1)/3)===row));
      if(rows.every(row=>row.length>=2)){
        const fy=rows.map(row=>median(row.map(e=>e.center.y))),dy=median([fy[1]-fy[0],fy[2]-fy[1]]);
        const columns=rows.map(row=>fit(row.map(e=>({index:(Number(e.text)-1)%3,...e.center}))));
        const dx=median(columns.map(r=>r.pitch)),cx=median(columns.map(r=>r.left+r.pitch)),cy=fy[2]+dy;
        if(dy>view.frame.height*.035&&dy<view.frame.height*.09&&dx>view.frame.width*.12&&dx<view.frame.width*.3&&columns.every(r=>Math.abs(r.pitch-dx)<dx*.12)&&Math.abs(fy[1]-fy[0]-dy)<dy*.15&&Math.abs(fy[2]-fy[1]-dy)<dy*.15){
          const {data,info}=await sharp(Buffer.from(view.frame.image.split(',')[1],'base64')).grayscale().raw().toBuffer({resolveWithObject:true});
          const patch=(x:number,y:number)=>{const values:number[]=[];for(let yy=Math.round(y)-2;yy<=Math.round(y)+2;yy++)for(let xx=Math.round(x)-2;xx<=Math.round(x)+2;xx++)if(xx>=0&&xx<info.width&&yy>=0&&yy<info.height)values.push(data[yy*info.width+xx]);return values.length===25?median(values):NaN;};
          if(Number.isFinite(patch(cx,cy))&&Math.abs(patch(cx,cy-dy*.3)-patch(cx,cy-dy*.5))>=10)keys['0']={x:cx,y:cy};
        }
      }
    }
    const top=Math.min(...ys);
    return { mode:"digits", keys, uppercase:false, top, pitch:40, anchors:digits.length };
  }
  if(keys.abc&&letters.length<8&&digits.length<8&&Object.keys(keys).length>=5)return {mode:"symbols",keys,uppercase:false,top:Math.min(...candidates.map(e=>e.center.y)),pitch:40,anchors:Object.keys(keys).length};
  if(!keys.space||!keys["123"])throw new Error("A complete visible Latin keyboard with space and mode controls is required");
  const fits=rows.map(row=>{
    const anchors=letters.filter(e=>row.includes(norm(e.text))).filter(e=>e.center.y<keys.space.y);
    const unique=anchors.filter(e=>anchors.filter(n=>norm(n.text)===norm(e.text)).length===1);
    if(unique.length<3)throw new Error("Not enough current letter anchors in each keyboard row");
    return {...fit(unique.map(e=>({index:row.indexOf(norm(e.text)),...e.center}))),anchors:unique.length};
  });
  const pitch=median(fits.map(r=>r.pitch));
  if(pitch<view.frame.width*.025||pitch>view.frame.width*.12||fits.some(r=>Math.abs(r.pitch-pitch)>pitch*.12)
    ||fits[1].y-fits[0].y<pitch*.7||fits[2].y-fits[1].y<pitch*.7
    ||fits[1].y-fits[0].y>pitch*2||fits[2].y-fits[1].y>pitch*2
    ||Math.abs((fits[1].left-fits[0].left)/pitch-.5)>.22||Math.abs((fits[2].left-fits[0].left)/pitch-1.5)>.22) {
    throw new Error("Visible keyboard does not match a regular QWERTY layout");
  }
  const {data,info}=await sharp(Buffer.from(view.frame.image.split(",")[1],"base64")).grayscale().raw().toBuffer({resolveWithObject:true});
  if(info.width!==view.frame.width||info.height!==view.frame.height)throw new Error("Keyboard raster geometry mismatch");
  const patch=(x:number,y:number,w:number,h:number)=>{
    const samples:number[]=[];
    for(let py=Math.round(y-h/2);py<=Math.round(y+h/2);py++)for(let px=Math.round(x-w/2);px<=Math.round(x+w/2);px++) {
      if(px<0||py<0||px>=info.width||py>=info.height)throw new Error("Keyboard key is outside the camera frame");
      samples.push(data[py*info.width+px]);
    }
    return median(samples);
  };
  let caps=0;
  fits.forEach((row,i)=>[...rows[i]].forEach((key,index)=>{
    const center={x:row.left+row.pitch*index,y:row.y};
    // Letter strokes cannot substitute for a rectangular key background.
    const inside=patch(center.x,center.y-pitch*.30,pitch*.35,pitch*.12);
    const gap=patch(center.x+pitch*.5,center.y-pitch*.30,pitch*.06,pitch*.12);
    if(Math.abs(inside-gap)>=7) { keys[key]=center;caps++; }
  }));
  if(caps<23)throw new Error(`Keyboard row fit lacks visible key-cap support (${caps}/26)`);
  // Shift is the one isolated high-contrast glyph left of the third letter row.
  const region={left:Math.round(fits[2].left-pitch*1.77),right:Math.round(fits[2].left-pitch*.93),
    top:Math.round(fits[2].y-pitch*.40),bottom:Math.round(fits[2].y+pitch*.40)};
  const lit:Point[]=[];
  const shiftBackground=patch(fits[2].left-pitch*1.35,fits[2].y-pitch*.39,pitch*.3,pitch*.06);
  for(let y=region.top;y<=region.bottom;y++)for(let x=region.left;x<=region.right;x++)if(x>=0&&x<info.width&&y>=0&&y<info.height&&Math.abs(data[y*info.width+x]-shiftBackground)>100)lit.push({x,y});
  if(lit.length>=35&&lit.length<pitch*pitch*.4) {
    const xs=lit.map(p=>p.x),ys=lit.map(p=>p.y),w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
    if(w>pitch*.25&&w<pitch*.8&&h>pitch*.25&&h<pitch*.8)keys.shift={x:(Math.min(...xs)+Math.max(...xs))/2,y:(Math.min(...ys)+Math.max(...ys))/2};
  }
  // c/o/s/v/w/x/z can look identical in lower/upper case and OCR often changes
  // their casing. Use only strongly case-distinct letter shapes for this gate.
  const caseLetters=letters.filter(e=>"abdefghnqrt".includes(norm(e.text)));
  const upper=caseLetters.filter(e=>e.text.trim()===e.text.trim().toUpperCase()).length/Math.max(1,caseLetters.length);
  return {mode:"letters",keys,uppercase:caseLetters.length<4?null:upper>=.8?true:upper<=.2?false:null,top:fits[0].y,pitch,anchors:fits.reduce((s,r)=>s+r.anchors,0)};
}

export type TextEntryReport = {status:"typed_unverified"|"blocked"|"action_uncertain"|"yielded";text:string;error?:string;elapsedMs:number;submittedPrefix?:string;
  keys:Array<{key:string;frameSequence:number;point:Point;receiptId?:string;elapsedMs:number}>;};
export async function typeVisibleText(deps:ControlDependencies,text:string,signal:AbortSignal, options: {
  verifyPrefix?: (view:LocalView,prefix:string,signal:AbortSignal)=>Promise<LocalView|void>;
  progress?: (report:TextEntryReport)=>Promise<void>;
  readKeyboard?:typeof readVisibleKeyboard;
  initialPrefix?:string;
  verifyEvery?:number;
  yieldWhen?:(view:LocalView)=>boolean;
} = {}):Promise<TextEntryReport> {
  if(!/^[\x20-\x7e]{1,120}$/.test(text))throw new Error("Visible typing supports bounded printable ASCII only, never Enter or submission");
  const start=performance.now(),report:TextEntryReport={status:"blocked",text,elapsedMs:0,keys:[],submittedPrefix:options.initialPrefix??''};
  try {
    const profile=await deps.getCalibration(signal);if(!profile)throw new Error("Verified screen geometry is required");
    const fingerprint=calibrationFingerprint(profile);
    if(options.initialPrefix&&!text.startsWith(options.initialPrefix))throw new Error("Resume prefix does not match the requested text");
    let index=options.initialPrefix?.length??0,switches=0;
    while(index<text.length) {
      signal.throwIfAborted();
      const [observed,device,current]=await Promise.all([deps.observe(signal),deps.getDevice(signal),deps.getCalibration(signal)]);
      if(observed.deviceId!==deps.deviceId||device.id!==deps.deviceId||!device.connected||!device.state?.grbl?.homed||device.state.grbl.state!=="Idle"
        ||device.state.grbl.activeOperation||device.state.grbl.liveTouch||!device.capabilities.actions.tap?.available)throw new Error("Typing needs a fresh, idle, homed device");
      if(!current||calibrationFingerprint(current)!==fingerprint)throw new Error("Calibration changed during text entry");
      if(options.yieldWhen?.(observed)){report.status='yielded';return report;}
      // Keep current keyboard geometry and receipts for every key. Read text at
      // bounded chunk boundaries: one-character OCR often merges with a caret.
      const stride=Math.max(1,Math.min(4,Math.floor(options.verifyEvery??1)));
      const verifyNow=(index-(options.initialPrefix?.length??0))%stride===0;
      const view=verifyNow?await options.verifyPrefix?.(observed,text.slice(0,index),signal)??observed:observed;
      const layout=await (options.readKeyboard??readVisibleKeyboard)(view,profile,signal),character=text[index],isLetter=/[a-z]/i.test(character);
      let key=character===" "?"space":character.toLowerCase(),advance=true;
      if(isLetter&&layout.mode!=="letters") {key="abc";advance=false;}
      else if(/\d/.test(character)&&layout.mode!=="digits") {key="123";advance=false;}
      else if(!isLetter&&!/\d/.test(character)&&character!==" "&&!layout.keys[key]){key=layout.mode==="letters"?"123":"#+=";advance=false;}
      else if(isLetter) {
        if(layout.uppercase===null)throw new Error("Keyboard capitalization is ambiguous; no case guessed");
        if(layout.uppercase!==(character===character.toUpperCase())){key="shift";advance=false;}
      }
      if(!advance&&++switches>3)throw new Error("Keyboard mode did not visibly switch; no more keys sent");
      const raw=layout.keys[key];if(!raw)throw new Error(`Key ${JSON.stringify(key)} was not verified in this frame`);
      const point=cameraToScreen(profile,raw);calibratedScreenPoint(profile,point);requireFreshFrame(view.frame.capturedAt);
      const record={key,point,frameSequence:view.frame.sequence,elapsedMs:0,receiptId:undefined as string|undefined};report.keys.push(record);
      report.status="action_uncertain";await options.progress?.(report);const started=performance.now();
      const result=await deps.act({type:"tap",point,viewport:profile.screen,frameSequence:view.frame.sequence,durationMs:55},signal,`visible-key-${randomUUID()}`);
      record.elapsedMs=performance.now()-started;record.receiptId=result.receipt.id;
      if(result.receipt.status!=="completed")throw new Error("Key press receipt is uncertain; text must not be retried");
      report.status="blocked";
      if(advance){index++;switches=0;}
      report.submittedPrefix=text.slice(0,index);
      await options.progress?.(report);
      await delay(120,undefined,{signal});
    }
    report.status="typed_unverified";
  }catch(error){report.error=error instanceof Error?error.message:String(error);}
  finally{report.elapsedMs=performance.now()-start;}
  return report;
}
