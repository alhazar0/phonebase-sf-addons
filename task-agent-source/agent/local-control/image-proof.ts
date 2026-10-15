import sharp from "sharp";
import type { LocalView } from "./executor";
import type { VisualTarget } from "./visual-target";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import { cameraToScreen } from "./geometry";
import { createHash } from "node:crypto";

type Region={left:number;top:number;width:number;height:number};
export type ImageProof={met:boolean;meanDifference:number;changedFraction:number;stableFromPrevious:boolean;roi:Region;
  basis:"localized_visual_change";storageVerified:false;reason:"no_change"|"illumination_only"|"unstable"|"occluded_or_flat"|"layout_moved"|"persistent_change";
  residualDifference:number;residualChangedFraction:number;stableForMs:number;independentFrames:number;baselineHash:string;currentHash:string};
const bytes=(view:LocalView)=>{
  if(!view.frame.image.startsWith("data:image/jpeg;base64,"))throw new Error("Image proof requires the current JPEG");
  return Buffer.from(view.frame.image.slice(23),"base64");
};
export function selectEffectRegion(before:LocalView,target:VisualTarget,side:"left_of_target"|"right_of_target",profile:ScreenHandCalibrationProfile):Region {
  const b=target.bounds;
  const candidates=(before.affordances??[]).filter(c=>{
    const r=c.bounds;
    if(c.confidence<.7||c.symbol||r.width<24||r.height<24||r.width/r.height<.6||r.width/r.height>1.6||r.width>b.width*1.5||r.height>b.height*1.5)return false;
    const dx=c.center.x-target.center.x,dy=c.center.y-target.center.y;
    if(Math.abs(dy)>b.height*.4||(side==="left_of_target"?dx>=-b.width:dx<=b.width))return false;
    if(Math.abs(dx)>profile.frame.width*.5)return false;
    // Text and known geometric controls are not image previews.
    if((before.visual?.targets??[]).some(t=>t.shapeScore>=.9&&Math.hypot(t.center.x-c.center.x,t.center.y-c.center.y)<Math.min(r.width,r.height)*.4))return false;
    if(before.elements.some(e=>e.confidence>=.65&&e.center.x>=r.left&&e.center.x<=r.left+r.width&&e.center.y>=r.top&&e.center.y<=r.top+r.height))return false;
    try{for(const p of [{x:r.left,y:r.top},{x:r.left+r.width,y:r.top+r.height}])cameraToScreen(profile,p);}catch{return false;}
    return true;
  });
  if(candidates.length!==1)throw new Error(`Visual effect needs one visible neighboring image candidate; found ${candidates.length}. No action sent.`);
  const r=candidates[0].bounds;
  // Exclude the decorative border/padding of the current detected component.
  const insetX=Math.max(2,Math.ceil(r.width*.13)),insetY=Math.max(2,Math.ceil(r.height*.13));
  const roi={left:Math.ceil(r.left)+insetX,top:Math.ceil(r.top)+insetY,width:Math.floor(r.width)-2*insetX,height:Math.floor(r.height)-2*insetY};
  if(roi.width<16||roi.height<16||roi.left<0||roi.top<0||roi.left+roi.width>before.frame.width||roi.top+roi.height>before.frame.height)throw new Error("No reliable neighboring image region");
  return roi;
}
const mean=(p:Buffer)=>p.reduce((a,b)=>a+b,0)/p.length;
const hash=(p:Buffer)=>createHash("sha256").update(p).digest("hex");
const norm=(s:string)=>s.normalize("NFKC").toLowerCase().trim();

/** Affine brightness compensation rejects exposure-only changes. This measures
 * persistent local image content, never asserts file persistence or causality. */
export async function prepareImageProof(before:LocalView,target:VisualTarget,side:"left_of_target"|"right_of_target",profile:ScreenHandCalibrationProfile) {
  const roi=selectEffectRegion(before,target,side,profile);
  const sample=async(v:LocalView)=>sharp(bytes(v),{limitInputPixels:12_000_000}).extract(roi).resize(64,64,{fit:"fill"}).grayscale().raw().toBuffer();
  const baseline=await sample(before),baselineMean=mean(baseline),baselineHash=hash(baseline);
  const baselineVariance=baseline.reduce((s,x)=>s+(x-baselineMean)**2,0)/baseline.length;
  if(baselineVariance<25)throw new Error("Neighboring image has insufficient texture for content verification; no action sent");
  let previous:Buffer|undefined,changeSince:number|undefined,independentFrames=0;
  let sequence=before.frame.sequence,capturedAt=before.frame.capturedAt;
  return async(after:LocalView):Promise<ImageProof>=>{
    if(after.deviceId!==before.deviceId||after.frame.width!==before.frame.width||after.frame.height!==before.frame.height)throw new Error("Image verification frame geometry/device changed");
    if(after.frame.sequence<=sequence||after.frame.capturedAt<=capturedAt||after.timing.ocrCacheHit||after.timing.ocrCapturedAt!==after.frame.capturedAt)throw new Error("Image verification requires independent fresh observations");
    sequence=after.frame.sequence;capturedAt=after.frame.capturedAt;
    const current=await sample(after),currentMean=mean(current);let diff=0,changed=0,interframe=0,covariance=0;
    for(let i=0;i<current.length;i++){const d=Math.abs(current[i]-baseline[i]);diff+=d;if(d>20)changed++;if(previous)interframe+=Math.abs(current[i]-previous[i]);}
    for(let i=0;i<current.length;i++)covariance+=(baseline[i]-baselineMean)*(current[i]-currentMean);
    const gain=covariance/current.length/baselineVariance,offset=currentMean-gain*baselineMean;
    let residual=0,residualChanged=0,variance=0;
    for(let i=0;i<current.length;i++) {
      const d=Math.abs(current[i]-(gain*baseline[i]+offset));residual+=d;if(d>20)residualChanged++;
      variance+=(current[i]-currentMean)**2;
    }
    const meanDifference=diff/current.length,changedFraction=changed/current.length;
    const stableFromPrevious=Boolean(previous)&&interframe/current.length<3;
    const residualDifference=residual/current.length,residualChangedFraction=residualChanged/current.length;
    const anchors=before.elements.filter(e=>e.confidence>=.8).flatMap(e=>{
      const matches=after.elements.filter(n=>n.confidence>=.8&&norm(e.text)===norm(n.text));
      return matches.length===1?[Math.hypot(e.center.x-matches[0].center.x,e.center.y-matches[0].center.y)]:[];
    });
    const layoutStable=anchors.length>=2&&anchors.every(d=>d<=Math.max(3,before.frame.width*.006));
    const flat=variance/current.length<25||currentMean<8||currentMean>247;
    const contentChanged=meanDifference>6&&changedFraction>.07&&residualDifference>6&&residualChangedFraction>.07;
    if(contentChanged&&layoutStable&&!flat) {
      if(!stableFromPrevious||changeSince===undefined){changeSince=capturedAt;independentFrames=1;}else independentFrames++;
    }else{changeSince=undefined;independentFrames=0;}
    const stableForMs=changeSince===undefined?0:capturedAt-changeSince;
    const met=contentChanged&&layoutStable&&!flat&&stableFromPrevious&&independentFrames>=3&&stableForMs>=500;
    const reason:ImageProof["reason"]=!layoutStable?"layout_moved":flat?"occluded_or_flat":met?"persistent_change":contentChanged?"unstable":meanDifference>6?"illumination_only":"no_change";
    previous=current;
    return {met,meanDifference,changedFraction,stableFromPrevious,roi,basis:"localized_visual_change",storageVerified:false,reason,
      residualDifference,residualChangedFraction,stableForMs,independentFrames,baselineHash,currentHash:hash(current)};
  };
}
