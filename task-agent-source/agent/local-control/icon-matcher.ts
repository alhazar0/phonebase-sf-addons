import {createHash} from "node:crypto";
import sharp from "sharp";
import {z} from "zod";

const SIDE=16;
export const iconTemplateSchema=z.object({version:z.literal(1),label:z.string().trim().min(1).max(120),
  deviceId:z.string().min(1).max(120),frame:z.object({width:z.number().int().positive(),height:z.number().int().positive()}).strict(),
  sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),sourceSequence:z.number().int().positive(),
  bounds:z.object({left:z.number().nonnegative(),top:z.number().nonnegative(),width:z.number().positive(),height:z.number().positive()}).strict(),
  descriptor:z.array(z.number().finite()).length(SIDE*SIDE),
}).strict();
export type IconTemplate=z.infer<typeof iconTemplateSchema>;
export type IconMatch={label:string;score:number;runnerUpScore:number;ambiguous:boolean;bounds:IconTemplate["bounds"];center:{x:number;y:number};source:"local_template"};
function standardized(values:ArrayLike<number>):number[] {
  const mean=Array.from(values).reduce((s,x)=>s+x,0)/values.length;
  const centered=Array.from(values,x=>x-mean),length=Math.sqrt(centered.reduce((s,x)=>s+x*x,0));
  if(length<20)throw new Error("Icon sample has insufficient visual contrast");
  return centered.map(x=>x/length);
}
/** Learn appearance only from an independently labeled icon crop. No screen
 * coordinates are reused when matching; every location is searched anew. */
export async function makeIconTemplate(bytes:Buffer,metadata:Omit<IconTemplate,"version"|"descriptor"|"sourceSha256">):Promise<IconTemplate> {
  const {bounds:b}=metadata;
  const info=await sharp(bytes,{limitInputPixels:12_000_000}).metadata();
  if(info.width!==metadata.frame.width||info.height!==metadata.frame.height)throw new Error("Icon sample dimensions mismatch");
  const region={left:Math.round(b.left),top:Math.round(b.top),width:Math.round(b.width),height:Math.round(b.height)};
  const pixels=await sharp(bytes).extract(region).resize(SIDE,SIDE,{fit:"fill"}).grayscale().raw().toBuffer();
  return iconTemplateSchema.parse({...metadata,version:1,descriptor:standardized(pixels),sourceSha256:createHash("sha256").update(bytes).digest("hex")});
}

/** Pure local multiscale appearance search. This produces a candidate, never
 * permission to touch or proof of application entry. Camera validation and
 * post-action verification remain the executor's responsibility. */
export async function matchIconTemplate(bytes:Buffer,template:IconTemplate,options:{deviceId:string;minimumScore?:number;margin?:number}):Promise<IconMatch|null> {
  iconTemplateSchema.parse(template);
  if(options.deviceId!==template.deviceId)throw new Error("Icon template belongs to another device");
  const metadata=await sharp(bytes,{limitInputPixels:12_000_000}).metadata();
  if(metadata.width!==template.frame.width||metadata.height!==template.frame.height)throw new Error("Icon frame dimensions changed");
  const {data,info}=await sharp(bytes).resize({width:240}).grayscale().raw().toBuffer({resolveWithObject:true});
  const scale=info.width/template.frame.width;
  const referenceWidth=template.bounds.width*scale,referenceHeight=template.bounds.height*scale;
  const candidates:Array<{score:number;x:number;y:number;w:number;h:number}>=[];
  for(const multiplier of [.8,.9,1,1.1,1.2,1.3,1.4]) {
    const w=Math.max(SIDE,Math.round(referenceWidth*multiplier)),h=Math.max(SIDE,Math.round(referenceHeight*multiplier));
    const offsets=Array.from({length:SIDE*SIDE},(_,i)=>Math.min(h-1,Math.floor((Math.floor(i/SIDE)+.5)*h/SIDE))*info.width+Math.min(w-1,Math.floor((i%SIDE+.5)*w/SIDE)));
    for(let y=0;y<=info.height-h;y+=2)for(let x=0;x<=info.width-w;x+=2){
      let sum=0,squares=0,dot=0;const base=y*info.width+x;
      for(let i=0;i<offsets.length;i++){const p=data[base+offsets[i]];sum+=p;squares+=p*p;dot+=p*template.descriptor[i];}
      const energy=squares-sum*sum/offsets.length;if(energy<400)continue;
      const score=dot/Math.sqrt(energy);
      if(score>=.6)candidates.push({score,x,y,w,h});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  // Coarse pixels only propose regions. Re-score the original camera crops
  // with the SAME resampling as the reference; small icons otherwise alias.
  const distinct:typeof candidates=[];
  for(const candidate of candidates){
    if(!distinct.some(c=>Math.abs(c.x-candidate.x)<3&&Math.abs(c.y-candidate.y)<3&&Math.abs(c.w-candidate.w)<2))distinct.push(candidate);
    if(distinct.length>=96)break;
  }
  const refined=await Promise.all(distinct.map(async c=>{
    const region={left:Math.round(c.x/scale),top:Math.round(c.y/scale),width:Math.round(c.w/scale),height:Math.round(c.h/scale)};
    const pixels=await sharp(bytes).extract(region).resize(SIDE,SIDE,{fit:"fill"}).grayscale().raw().toBuffer();
    let score=0;try{const descriptor=standardized(pixels);score=descriptor.reduce((s,x,i)=>s+x*template.descriptor[i],0);}catch{return {...c,score:0};}
    return {...c,score};
  }));
  refined.sort((a,b)=>b.score-a.score);const best=refined[0];if(!best)return null;
  // Nearby scales/positions of the same icon are one candidate, not ambiguity.
  const second=refined.find(c=>Math.hypot(c.x+c.w/2-best.x-best.w/2,c.y+c.h/2-best.y-best.h/2)>Math.max(best.w,best.h)*.7);
  const runnerUpScore=second?.score??0;
  const bounds={left:best.x/scale,top:best.y/scale,width:best.w/scale,height:best.h/scale};
  return {label:template.label,score:best.score,runnerUpScore,ambiguous:best.score<(options.minimumScore??.88)||best.score-runnerUpScore<(options.margin??.08),bounds,
    center:{x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2},source:"local_template"};
}
