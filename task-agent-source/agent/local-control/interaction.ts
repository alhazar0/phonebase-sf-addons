import {z} from "zod";
import {buildTextDocument} from "../local-perception/text-semantics";
import type {LocalView} from "./executor";

export const cameraRegionSchema=z.object({left:z.number().min(0).max(1),top:z.number().min(0).max(1),right:z.number().min(0).max(1),bottom:z.number().min(0).max(1)}).strict().refine(r=>r.left<r.right&&r.top<r.bottom,"Invalid camera region");
export const observedTargetSchema=z.object({text:z.string().trim().min(1).max(120),region:cameraRegionSchema,control:z.object({role:z.enum(["icon","control","navigation"]),width:z.number().positive(),height:z.number().positive()}).strict().optional()}).strict();
export const interactionSchema=z.object({targetId:z.string().regex(/^[tc]\d{1,2}$/),result:z.object({region:cameraRegionSchema,text:z.string().trim().min(1).max(120)}).strict().nullable()}).strict();
export type CameraRegion=z.infer<typeof cameraRegionSchema>;
export function regionContains(region:CameraRegion,element:LocalView["elements"][number],view:LocalView){
  const x=element.center.x/view.frame.width,y=element.center.y/view.frame.height;
  return x>=region.left&&x<=region.right&&y>=region.top&&y<=region.bottom;
}
export function bindObservedTarget(view:LocalView,id:string){
  if(/^c\d+$/.test(id)){
    const a=observedControls(view)[Number(id.slice(1))];if(!a)throw new Error("Control ID is not in the planning observation");const b=a.bounds;
    return {text:`${a.role}:${a.symbol??"unlabeled"}`,region:{left:Math.max(0,(b.left-6)/view.frame.width),top:Math.max(0,(b.top-6)/view.frame.height),right:Math.min(1,(b.left+b.width+6)/view.frame.width),bottom:Math.min(1,(b.top+b.height+6)/view.frame.height)},control:{role:a.role,width:b.width,height:b.height}};
  }
  const node=buildTextDocument(view).nodes.find(n=>n.id===id);if(!node)throw new Error("Target ID is not in the planning observation");
  const [x,y,w,h]=node.box;return {text:node.text,region:{left:Math.max(0,(x-12)/1000),top:Math.max(0,(y-12)/1000),right:Math.min(1,(x+w+12)/1000),bottom:Math.min(1,(y+h+12)/1000)}};
}
export function observedTarget(view:LocalView,target:z.infer<typeof observedTargetSchema>){
  if(target.control){const spec=target.control;
    const matches=observedControls(view).filter(a=>a.role===spec.role&&a.bounds.width/spec.width>.6&&a.bounds.width/spec.width<1.6&&a.bounds.height/spec.height>.6&&a.bounds.height/spec.height<1.6&&regionContains(target.region,{center:a.center} as LocalView["elements"][number],view));
    if(matches.length!==1)throw new Error("Observed visual control moved, disappeared or became ambiguous; no action sent");
    return {id:"observed-control",role:"text" as const,text:target.text,confidence:matches[0].confidence,center:matches[0].center,bounds:matches[0].bounds};
  }
  const matches=view.elements.filter(e=>e.confidence>=.9&&e.text.normalize("NFKC").trim()===target.text.normalize("NFKC").trim()&&regionContains(target.region,e,view));
  if(matches.length!==1)throw new Error("Observed control moved, disappeared or became ambiguous; no action sent");
  return matches[0];
}
export function readRegion(view:LocalView,region:CameraRegion){
  return view.elements.filter(e=>e.confidence>=.9&&regionContains(region,e,view)).sort((a,b)=>a.center.y-b.center.y||a.center.x-b.center.x).map(e=>e.text.normalize("NFKC").trim()).join(" ");
}
export function regionHasUniqueText(view:LocalView,region:CameraRegion,text:string){
  return view.elements.filter(e=>e.confidence>=.9&&regionContains(region,e,view)&&e.text.normalize("NFKC").trim()===text.normalize("NFKC").trim()).length===1;
}

/** Neutral current-frame components, not app-specific icon/action names. */
export function observedControls(view:LocalView){
  return (view.affordances??[]).filter(a=>a.confidence>=.8&&a.bounds.width>=14&&a.bounds.height>=14&&a.bounds.width*a.bounds.height<view.frame.width*view.frame.height*.06&&a.bounds.left>=0&&a.bounds.top>=0&&a.bounds.left+a.bounds.width<=view.frame.width&&a.bounds.top+a.bounds.height<=view.frame.height&&(!view.state.keyboard||a.bounds.top+a.bounds.height<observedKeyboardTop(view)))
    .sort((a,b)=>a.center.y-b.center.y||a.center.x-b.center.x).slice(0,24);
}

/** Conservative keyboard exclusion from observed single-key rows. This only
 * bounds navigation; input still requires full pixel-verified key geometry. */
export function observedKeyboardTop(view:LocalView):number {
  if(!view.state.keyboard)return view.frame.height;
  const keys=view.elements.filter(e=>e.confidence>=.65&&/^(?:[a-z0-9]|0\s*\+)$/i.test(e.text.trim())&&e.center.y>view.frame.height*.5);
  const row=keys.filter(e=>keys.filter(k=>Math.abs(k.center.y-e.center.y)<Math.max(10,e.bounds.height*.5)).length>=3);
  return row.length?Math.min(...row.map(e=>e.bounds.top-e.bounds.height*.6)):view.frame.height*.58;
}
