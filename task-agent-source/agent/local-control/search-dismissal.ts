import sharp from "sharp";
import {createHash} from "node:crypto";
import type {ScreenElement} from "../general-agent-contract";
import type {VisualAffordance} from "../visual-affordance-detector";
import {canonicalLabel} from "./text-label";

type SearchView = {frame:{width:number;height:number};state:{keyboard:boolean;overlay:string};elements:ScreenElement[]};
type BackdropView = SearchView & {frame:{width:number;height:number;sequence:number;image:string};affordances?:VisualAffordance[]};
export type SearchBackdrop = {sourceSequence:number;imageHash:string;bounds:{left:number;top:number;width:number;height:number};
  center:{x:number;y:number};anchors:string[];edgeFraction:number};

/** OS search is a dismissible surface, not the alphabetical App Library. */
export function systemSearchEvidence(view:SearchView) {
  if(view.state.overlay!=="none"||!view.state.keyboard)return null;
  const es=view.elements.filter(e=>e.confidence>=.9),h=view.frame.height;
  const headings=es.filter(e=>/^(siri suggestions|siri 建议|siri建议)$/i.test(e.text.trim())&&e.center.y>h*.1&&e.center.y<h*.3);
  const fields=es.filter(e=>/^(search|搜索)$/.test(canonicalLabel(e.text))&&e.center.y>h*.4&&e.center.y<h*.75);
  const more=es.filter(e=>/^(show more|显示更多|更多)$/i.test(e.text.trim())&&e.center.y<h*.3);
  if(headings.length!==1||fields.length!==1||more.length!==1)return null;
  if(Math.abs(more[0].center.y-headings[0].center.y)>h*.025)return null;
  return {heading:headings[0],field:fields[0],more:more[0]};
}

/** Populated system search has different headings from its empty suggestion
 * page. An exact result is separate evidence from inline query completion. */
export function systemSearchResultsEvidence(view:SearchView) {
  if(view.state.overlay!=='none'||!view.state.keyboard)return null;
  const es=view.elements.filter(e=>e.confidence>=.9),h=view.frame.height;
  const headings=es.filter(e=>/^(top hit|最佳结果|最常点选)$/i.test(e.text.trim())&&e.center.y>h*.1&&e.center.y<h*.3);
  const next=es.filter(e=>/^(suggestions|建议)$/i.test(e.text.trim())&&e.center.y>h*.2&&e.center.y<h*.55);
  if(headings.length!==1||next.length!==1||next[0].center.y<=headings[0].center.y)return null;
  const targets=es.filter(e=>e.bounds.top>headings[0].bounds.top+headings[0].bounds.height&&e.bounds.top+e.bounds.height<next[0].bounds.top);
  return {heading:headings[0],sectionEnd:next[0],targets};
}

export function systemSearchResultTarget(view:SearchView,text:string) {
  const matches=systemSearchResultsEvidence(view)?.targets.filter(e=>e.text.normalize('NFKC').trim().toLowerCase()===text.normalize('NFKC').trim().toLowerCase())??[];
  return matches.length===1?matches[0]:null;
}

/** Choose a large empty gap from observed content rows, then inspect its pixels.
 * OCR absence alone cannot make an image or unlabeled button a backdrop. */
export async function detectSearchBackdrop(view:BackdropView):Promise<SearchBackdrop|null> {
  const evidence=systemSearchEvidence(view);if(!evidence)return null;
  const prefix="data:image/jpeg;base64,";if(!view.frame.image.startsWith(prefix))return null;
  const bytes=Buffer.from(view.frame.image.slice(prefix.length),"base64");
  const decoded=await sharp(bytes,{limitInputPixels:12_000_000}).grayscale().raw().toBuffer({resolveWithObject:true});
  const {width:w,height:h}=decoded.info;if(w!==view.frame.width||h!==view.frame.height)return null;
  const left=Math.max(evidence.heading.bounds.left,evidence.field.bounds.left);
  const right=evidence.more.bounds.left+evidence.more.bounds.width;
  if(right-left<w*.3)return null;
  const rows=view.elements.filter(e=>e.confidence>=.5&&e.center.y>=evidence.heading.center.y&&e.center.y<=evidence.field.center.y)
    .map(e=>({top:e.bounds.top,bottom:e.bounds.top+e.bounds.height})).sort((a,b)=>a.top-b.top);
  const bands:typeof rows=[];
  for(const row of rows){const last=bands.at(-1);if(last&&row.top<=last.bottom+h*.012)last.bottom=Math.max(last.bottom,row.bottom);else bands.push({...row});}
  const candidates:SearchBackdrop[]=[];
  for(let i=1;i<bands.length;i++){
    const top=bands[i-1].bottom+h*.025,bottom=bands[i].top-h*.025,gap=bottom-top;
    if(gap<h*.075)continue;
    const width=Math.floor((right-left)*.45),height=Math.floor(Math.min(gap*.75,h*.12));
    const bounds={left:Math.round((left+right-width)/2),top:Math.round((top+bottom-height)/2),width,height};
    if(bounds.left<0||bounds.top<0||bounds.left+width>w||bounds.top+height>h)continue;
    const overlaps=(b:SearchBackdrop["bounds"])=>b.left<bounds.left+width&&b.left+b.width>bounds.left&&b.top<bounds.top+height&&b.top+b.height>bounds.top;
    if(view.elements.some(e=>overlaps(e.bounds))||(view.affordances??[]).some(e=>e.confidence>=.6&&overlaps(e.bounds)))continue;
    let strong=0,total=0,sum=0;
    // Inspect the entire gap, including the border of a possible enclosing
    // unlabeled button; a flat crop inside that button is not a backdrop.
    for(let y=Math.ceil(top)+1;y<Math.floor(bottom)-1;y++)for(let x=Math.ceil(left)+1;x<Math.floor(right)-1;x++){
      const at=y*w+x,dx=Math.abs(decoded.data[at+1]-decoded.data[at-1]),dy=Math.abs(decoded.data[at+w]-decoded.data[at-w]);
      if(Math.max(dx,dy)>18)strong++;sum+=dx+dy;total++;
    }
    const edgeFraction=strong/Math.max(total,1);
    if(edgeFraction>.005||sum/Math.max(total,1)>5)continue;
    candidates.push({sourceSequence:view.frame.sequence,imageHash:createHash("sha256").update(bytes).digest("hex"),bounds,
      center:{x:bounds.left+width/2,y:bounds.top+height/2},anchors:[evidence.heading.text,evidence.more.text],edgeFraction});
  }
  return candidates.sort((a,b)=>b.bounds.width*b.bounds.height-a.bounds.width*a.bounds.height)[0]??null;
}

export function currentSearchBackdrop(view:BackdropView & {searchBackdrop?:SearchBackdrop|null}):SearchBackdrop {
  const target=view.searchBackdrop;
  if(!systemSearchEvidence(view)||!target||target.sourceSequence!==view.frame.sequence||
    target.imageHash!==createHash("sha256").update(Buffer.from(view.frame.image.split(",")[1]??"","base64")).digest("hex"))
    throw new Error("No current pixel-checked system-search backdrop; no guessed center tap");
  return target;
}
