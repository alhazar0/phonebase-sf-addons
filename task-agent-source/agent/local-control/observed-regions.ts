import sharp from "sharp";
import {createHash} from "node:crypto";
import type {ScreenElement} from "../general-agent-contract";
import type {VisualAffordance} from "../visual-affordance-detector";

type RegionView={frame:{width:number;height:number;sequence:number;image:string};state:{overlay:string};elements:ScreenElement[];affordances?:VisualAffordance[]};
export type ObservedRegion={id:string;kind:"low_texture_gap";sourceSequence:number;imageHash:string;
  bounds:{left:number;top:number;width:number;height:number};center:{x:number;y:number};edgeFraction:number};

/** Pixel/row geometry only. No OS names, page labels, goal or predicted effect.
 * Empty-looking pixels are a candidate, never proof of a dismissible surface. */
export async function detectObservedRegions(view:RegionView):Promise<ObservedRegion[]> {
  if(view.state.overlay!=="none"||!view.frame.image.startsWith("data:image/jpeg;base64,"))return [];
  const {width:w,height:h}=view.frame;
  const es=view.elements.filter(e=>e.confidence>=.65&&e.text.trim().length>=2&&e.center.y>h*.12&&e.center.y<h*.68);
  if(es.length<3)return [];
  const left=Math.max(w*.16,Math.min(...es.map(e=>e.bounds.left))),right=Math.min(w*.84,Math.max(...es.map(e=>e.bounds.left+e.bounds.width)));
  if(right-left<w*.3)return [];
  const rows=es.map(e=>({top:e.bounds.top,bottom:e.bounds.top+e.bounds.height})).sort((a,b)=>a.top-b.top),bands:typeof rows=[];
  for(const row of rows){const last=bands.at(-1);if(last&&row.top<=last.bottom+h*.012)last.bottom=Math.max(last.bottom,row.bottom);else bands.push({...row});}
  const bytes=Buffer.from(view.frame.image.split(",")[1],"base64");
  if(bytes.length>8_000_000)return [];
  const decoded=await sharp(bytes,{limitInputPixels:12_000_000}).grayscale().raw().toBuffer({resolveWithObject:true});
  if(decoded.info.width!==w||decoded.info.height!==h)return [];
  const candidates:ObservedRegion[]=[];
  for(let i=1;i<bands.length;i++){
    const top=bands[i-1].bottom+h*.025,bottom=bands[i].top-h*.025,gap=bottom-top;if(gap<h*.075)continue;
    const width=Math.floor((right-left)*.45),height=Math.floor(Math.min(gap*.75,h*.12));
    const bounds={left:Math.round((left+right-width)/2),top:Math.round((top+bottom-height)/2),width,height};
    if(top<0||bottom>h||bounds.left<0||bounds.top<0||bounds.left+width>w||bounds.top+height>h)continue;
    const overlaps=(b:ObservedRegion["bounds"])=>b.left<bounds.left+width&&b.left+b.width>bounds.left&&b.top<bounds.top+height&&b.top+b.height>bounds.top;
    if(view.elements.some(e=>overlaps(e.bounds))||(view.affordances??[]).some(e=>e.confidence>=.6&&overlaps(e.bounds)))continue;
    let strong=0,total=0,sum=0;
    // Include surrounding edges: a flat interior of an unlabeled button is not an empty gap.
    for(let y=Math.ceil(top)+1;y<Math.floor(bottom)-1;y++)for(let x=Math.ceil(left)+1;x<Math.floor(right)-1;x++){
      const at=y*w+x,dx=Math.abs(decoded.data[at+1]-decoded.data[at-1]),dy=Math.abs(decoded.data[at+w]-decoded.data[at-w]);
      if(Math.max(dx,dy)>18)strong++;sum+=dx+dy;total++;
    }
    const edgeFraction=strong/Math.max(total,1);if(edgeFraction>.005||sum/Math.max(total,1)>5)continue;
    candidates.push({id:"gap_0",kind:"low_texture_gap",sourceSequence:view.frame.sequence,imageHash:createHash("sha256").update(bytes).digest("hex"),bounds,
      center:{x:bounds.left+width/2,y:bounds.top+height/2},edgeFraction});
  }
  // One best candidate keeps identity stable across small OCR changes and prevents
  // walking around the same ineffective empty surface by changing target IDs.
  return candidates.sort((a,b)=>b.bounds.width*b.bounds.height-a.bounds.width*a.bounds.height).slice(0,1);
}

export function currentObservedRegion(view:RegionView & {regions?:ObservedRegion[]},id:string) {
  const target=view.regions?.find(r=>r.id===id);
  if(view.state.overlay!=="none"||!target||target.sourceSequence!==view.frame.sequence||
    target.imageHash!==createHash("sha256").update(Buffer.from(view.frame.image.split(",")[1]??"","base64")).digest("hex"))
    throw new Error("No current image-checked region with this ID");
  return target;
}

export function sameObservedRegion(a:RegionView & {regions?:ObservedRegion[]},b:RegionView & {regions?:ObservedRegion[]},id:string) {
  const first=currentObservedRegion(a,id),second=currentObservedRegion(b,id);
  return a.frame.width===b.frame.width&&a.frame.height===b.frame.height&&
    Math.abs(first.center.x-second.center.x)<a.frame.width*.02&&Math.abs(first.center.y-second.center.y)<a.frame.height*.02&&
    Math.abs(first.bounds.width-second.bounds.width)<a.frame.width*.03&&Math.abs(first.bounds.height-second.bounds.height)<a.frame.height*.03;
}
