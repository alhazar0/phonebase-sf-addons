import sharp from "sharp";
import { z } from "zod";
import type { VisualAffordance } from "../visual-affordance-detector";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import type { LocalView } from "./executor";
import type { ScreenElement } from "../general-agent-contract";
import { cameraToScreen } from "./geometry";

export const visualSelectorSchema=z.object({
  shape:z.enum(["filled_circle","camera_glyph"]),
  tone:z.enum(["light","dark"]).optional(),
  anchor:z.object({text:z.string().trim().min(1).max(120),relation:z.enum(["above","below","left","right"])}).strict().optional(),
}).strict();
export type VisualSelector=z.infer<typeof visualSelectorSchema>;
export type VisualTarget=VisualAffordance & {shape:"filled_circle"|"camera_glyph";tone:"light"|"dark";shapeScore:number};
export type VisualFeatures={targets:VisualTarget[];accentText:string[]};

const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const norm=(s:string)=>s.normalize("NFKC").toLowerCase().trim();

export function hasYellowText(rgb:Buffer):boolean {
  let foreground=0,yellow=0;
  for(let i=0;i+2<rgb.length;i+=3) {
    const r=rgb[i],g=rgb[i+1],b=rgb[i+2];
    if(r<=60||g<=60)continue;
    foreground++;
    if(r>80&&g>70&&b<Math.min(r,g)*.78&&r/g>.85&&r/g<1.8)yellow++;
  }
  // Count colored strokes relative to visible foreground, not black box padding.
  // A uniformly yellow background is not enough to call a word highlighted.
  return yellow>=12&&yellow/Math.max(1,foreground)>.6&&foreground/(rgb.length/3)<.65;
}

/** Separate intensity components when blurred edge dilation joins a label and
 * its neighboring control. Coordinates always come from this candidate's pixels. */
async function splitSolidCandidates(data:Buffer,info:{width:number;height:number;channels:3},candidate:VisualAffordance):Promise<VisualTarget[]> {
  const b=candidate.bounds,roi={left:Math.floor(b.left),top:Math.floor(b.top),width:Math.ceil(b.width),height:Math.ceil(b.height)};
  if(roi.width*roi.height>100_000)return [];
  const gray=await sharp(data,{raw:info}).extract(roi).grayscale().raw().toBuffer();
  let minimum=255,maximum=0;for(const p of gray){minimum=Math.min(minimum,p);maximum=Math.max(maximum,p);}
  if(maximum-minimum<110)return [];
  const threshold=(minimum+maximum)/2,results:VisualTarget[]=[];
  for(const light of [true,false]) {
    const seen=new Uint8Array(gray.length),queue=new Int32Array(gray.length);
    const active=(i:number)=>light?gray[i]>threshold:gray[i]<threshold;
    for(let seed=0;seed<gray.length;seed++) {
      if(seen[seed]||!active(seed))continue;
      let head=0,tail=1,left=roi.width,right=0,top=roi.height,bottom=0;queue[0]=seed;seen[seed]=1;
      while(head<tail) {
        const i=queue[head++],x=i%roi.width,y=Math.floor(i/roi.width);
        left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
        for(const j of [x?i-1:-1,x<roi.width-1?i+1:-1,y?i-roi.width:-1,y<roi.height-1?i+roi.width:-1]) {
          if(j>=0&&!seen[j]&&active(j)){seen[j]=1;queue[tail++]=j;}
        }
      }
      const w=right-left+1,h=bottom-top+1;
      if(tail<200||w<20||h<20||w/h<.8||w/h>1.25||tail/(w*h)<.6||tail/(w*h)>.9)continue;
      if(left===0||top===0||right===roi.width-1||bottom===roi.height-1)continue;
      const px=Math.ceil(w*.13),py=Math.ceil(h*.13);
      const bounds={left:roi.left+left-px,top:roi.top+top-py,width:w+px*2,height:h+py*2};
      if(bounds.left<0||bounds.top<0||bounds.left+bounds.width>info.width||bounds.top+bounds.height>info.height)continue;
      const patch=await sharp(data,{raw:info}).extract(bounds).resize(40,40).grayscale().raw().toBuffer();
      const description=describePatch(patch,40,40);
      if(description?.shape==="filled_circle")results.push({...candidate,...description,bounds,center:{x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2},source:"local_intensity"});
    }
  }
  return results;
}

/** Geometric/intensity templates describe glyphs, not applications or tasks.
 * No screen-relative tap constants, trained-model accuracy claims or cloud calls. */
export function describePatch(pixels:Buffer,width:number,height:number):Omit<VisualTarget,keyof VisualAffordance>|null {
  if(width!==40||height!==40||pixels.length!==width*height)return null;
  const samples=(predicate:(x:number,y:number)=>boolean)=>{
    const values:number[]=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(predicate((x+.5)/width,(y+.5)/height))values.push(pixels[y*width+x]);return values;
  };
  const disk=samples((x,y)=>Math.hypot((x-.5)*2,(y-.5)*2)<.55);
  const corner=samples((x,y)=>Math.abs(x-.5)>.35&&Math.abs(y-.5)>.35);
  const diskMean=mean(disk),cornerMean=mean(corner),contrast=diskMean-cornerMean;
  const uniform=disk.filter(v=>Math.abs(v-diskMean)<35).length/disk.length;
  const at=(x:number,y:number)=>pixels[Math.max(0,Math.min(39,Math.round(y)))*40+Math.max(0,Math.min(39,Math.round(x)))];
  // Find the first disk boundary, ignoring any outer decorative ring. A padded
  // square also has dark corners but its diagonal radii are substantially longer.
  const radii=Array.from({length:16},(_,i)=>{
    const angle=i*Math.PI/8,inside=(r:number)=>Math.sign(contrast)*(at(19.5+Math.cos(angle)*r,19.5+Math.sin(angle)*r)-cornerMean)>Math.abs(contrast)*.5;
    for(let r=8;r<=27;r+=.5)if(!inside(r)&&!inside(r+.5))return r;
    return 28;
  });
  // Two rays may merge with a decorative ring after camera blur/JPEG sampling.
  // Trim those outliers; a square has four long diagonal rays and still fails.
  const sortedRadii=[...radii].sort((a,b)=>a-b);
  const roundBoundary=sortedRadii[13]/sortedRadii[2]<1.23&&Math.max(...radii)<23;
  // Hollow rings have no filled center; solid controls also need a round edge.
  if(Math.abs(contrast)>100&&uniform>.94) {
    const middle=samples((x,y)=>{const r=Math.hypot((x-.5)*2,(y-.5)*2);return r>.62&&r<.72;});
    if(roundBoundary&&Math.sign(contrast)*(mean(middle)-cornerMean)>Math.abs(contrast)*.55) {
      return {shape:"filled_circle",tone:contrast>0?"light":"dark",shapeScore:Math.min(.99,.8+Math.abs(contrast)/1500)};
    }
  }
  // A camera glyph has a bright lens ring inside a dark wide body, unlike a
  // search ring, clock dial, solid circle or play triangle. Search across the
  // candidate patch, never across remembered screen coordinates.
  let best=0;
  for(let cy=12;cy<=23;cy++)for(let cx=14;cx<=25;cx++)for(let radius=4;radius<=8;radius++) {
    const ring=Array.from({length:12},(_,i)=>{
      const angle=i*Math.PI/6;return Math.max(...[-.75,0,.75].map(d=>at(cx+Math.cos(angle)*(radius+d),cy+Math.sin(angle)*(radius+d))));
    });
    const lens=[at(cx,cy),at(cx-radius*.3,cy),at(cx+radius*.3,cy),at(cx,cy-radius*.3),at(cx,cy+radius*.3)];
    const body=[-1,1].flatMap(sign=>[-.5,0,.5].map(y=>at(cx+sign*(radius+3),cy+y*radius)));
    const above=[-1,0,1].map(x=>at(cx+x*radius,cy-radius-5));
    const ringMean=mean(ring),bodyMean=mean(body),lensMean=mean(lens);
    if(ringMean>125&&ring.filter(v=>v>bodyMean+65).length>=10&&ringMean-lensMean>70&&
      ringMean-bodyMean>80&&mean(above)-bodyMean>40&&body.filter(v=>v<ringMean-65).length===6) {
      best=Math.max(best,Math.min(.98,.80+(ringMean-bodyMean)/1500));
    }
  }
  return best?{shape:"camera_glyph",tone:"dark",shapeScore:best}:null;
}

export async function extractVisualFeatures(view:{frame:{image:string;width:number;height:number};elements:ScreenElement[];affordances?:VisualAffordance[]},profile?:ScreenHandCalibrationProfile):Promise<VisualFeatures> {
  if(!view.frame.image.startsWith("data:image/jpeg;base64,"))throw new Error("Visual grounding requires this frame's camera JPEG");
  const bytes=Buffer.from(view.frame.image.slice("data:image/jpeg;base64,".length),"base64");
  const {data,info}=await sharp(bytes,{limitInputPixels:12_000_000}).removeAlpha().toColourspace("srgb").raw().toBuffer({resolveWithObject:true});
  if(info.width!==view.frame.width||info.height!==view.frame.height||info.channels!==3)throw new Error("Visual frame geometry mismatch");
  const targets:VisualTarget[]=[];
  for(const candidate of view.affordances??[]) {
    if(candidate.confidence<.65)continue;
    if(profile)try{cameraToScreen(profile,candidate.center);}catch{continue;}
    const b=candidate.bounds;const aspect=b.width/b.height;
    if(aspect<.4||aspect>2.5||b.width<20||b.height<20)continue;
    const roi={left:Math.floor(b.left),top:Math.floor(b.top),width:Math.ceil(b.width),height:Math.ceil(b.height)};
    if(roi.left<0||roi.top<0||roi.left+roi.width>info.width||roi.top+roi.height>info.height)continue;
    const pixels=await sharp(data,{raw:info}).extract(roi).resize(40,40).grayscale().raw().toBuffer();
    const description=aspect>=.72&&aspect<=1.4?describePatch(pixels,40,40):null;
    if(description)targets.push({...candidate,...description});
    else targets.push(...await splitSolidCandidates(data,{width:info.width,height:info.height,channels:3},candidate));
  }
  const accentText:string[]=[];
  // Yellow foreground is exposed as an observed style, not as an assertion
  // that every colored word is selected. The plan must name the required text.
  for(const element of view.elements.filter(e=>e.confidence>=.65)) {
    const b=element.bounds;const pixels:number[]=[];
    for(let y=Math.max(0,Math.floor(b.top));y<Math.min(info.height,Math.ceil(b.top+b.height));y++)for(let x=Math.max(0,Math.floor(b.left));x<Math.min(info.width,Math.ceil(b.left+b.width));x++) {
      const i=(y*info.width+x)*3,r=data[i],g=data[i+1],blue=data[i+2];
      pixels.push(r,g,blue);
    }
    if(hasYellowText(Buffer.from(pixels)))accentText.push(element.text);
  }
  const unique=targets.filter((t,i)=>!targets.slice(0,i).some(p=>p.shape===t.shape&&Math.hypot(p.center.x-t.center.x,p.center.y-t.center.y)<Math.min(p.bounds.width,t.bounds.width)*.25));
  return {targets:unique,accentText};
}

export function selectVisualTarget(selector:VisualSelector,view:LocalView,profile:ScreenHandCalibrationProfile):VisualTarget {
  let candidates=(view.visual?.targets??[]).filter(t=>t.shape===selector.shape&&(!selector.tone||selector.tone===t.tone)&&t.shapeScore>=.8);
  candidates=candidates.filter(t=>{try{cameraToScreen(profile,t.center);return true;}catch{return false;}});
  if(selector.anchor) {
    const anchor=selector.anchor;
    const labels=view.elements.filter(e=>e.confidence>=.65&&norm(e.text)===norm(anchor.text));
    if(labels.length!==1)throw new Error("Visual selector requires one current text anchor");
    const p=cameraToScreen(profile,labels[0].center);
    candidates=candidates.filter(t=>{
      const q=cameraToScreen(profile,t.center);const dx=(q.x-p.x)/profile.screen.width,dy=(q.y-p.y)/profile.screen.height;
      return anchor.relation==="below"?dy>.01&&dy<.25&&Math.abs(dx)<.15:
        anchor.relation==="above"?dy<-.01&&dy>-.25&&Math.abs(dx)<.15:
        anchor.relation==="left"?dx<-.01&&dx>-.5&&Math.abs(dy)<.10:dx>.01&&dx<.5&&Math.abs(dy)<.10;
    });
  }
  if(candidates.length!==1)throw new Error(`Expected one current visual target; found ${candidates.length}`);
  return candidates[0];
}
