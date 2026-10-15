import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {z} from "zod";
import {iconTemplateSchema,matchIconTemplate,type IconMatch} from "./icon-matcher";
import type {LocalView} from "./executor";
import {navigationLayout} from "./navigation-grounding";

export const iconLibrarySchema=z.object({version:z.literal(1),deviceId:z.string().min(1).max(120),
  calibrationFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  stage:z.literal("development"),templates:z.array(iconTemplateSchema).min(1).max(12),
}).strict();
export type IconLibrary=z.infer<typeof iconLibrarySchema>;
export type BoundAppIcon=IconMatch&{frameSequence:number;frameSha256:string;calibrationFingerprint:string};
export async function readIconLibrary(path:string):Promise<IconLibrary>{
  const bytes=await readFile(path);if(bytes.length>200_000)throw new Error("Icon library exceeds limit");
  const library=iconLibrarySchema.parse(JSON.parse(bytes.toString("utf8")));
  if(library.templates.some(t=>t.deviceId!==library.deviceId))throw new Error("Mixed device icon library");
  return library;
}
/** Explicit experimental opt-in. Descriptors are reused, positions never are.
 * Missing/uncertain matches simply leave ordinary labeled navigation in charge. */
export function iconResolver(library:IconLibrary,calibrationFingerprint:string){
  iconLibrarySchema.parse(library);
  if(library.calibrationFingerprint!==calibrationFingerprint)throw new Error("Icon library calibration changed; revalidate samples");
  return async(view:LocalView,target?:string):Promise<BoundAppIcon[]>=>{
    if(view.deviceId!==library.deviceId)throw new Error("Icon library device mismatch");
    if(!target||view.state.overlay!=="none"||view.state.keyboard||!navigationLayout(view).categoryGrid)return [];
    const templates=library.templates.filter(t=>t.label.normalize("NFKC").toLowerCase()===target.normalize("NFKC").toLowerCase());
    if(templates.length!==1)return [];
    const bytes=Buffer.from(view.frame.image.split(",")[1],"base64");
    const match=await matchIconTemplate(bytes,templates[0],{deviceId:view.deviceId});
    if(!match||match.ambiguous)return [];
    return [{...match,frameSequence:view.frame.sequence,frameSha256:createHash("sha256").update(bytes).digest("hex"),calibrationFingerprint}];
  };
}

export function currentAppIcon(view:LocalView,label:string,calibrationFingerprint?:string):BoundAppIcon|null{
  const matches=(view.appIcons??[]).filter(c=>!c.ambiguous&&c.score>=.88&&c.score-c.runnerUpScore>=.08&&
    c.label.normalize("NFKC").toLowerCase()===label.normalize("NFKC").toLowerCase()&&c.frameSequence===view.frame.sequence&&
    (!calibrationFingerprint||c.calibrationFingerprint===calibrationFingerprint));
  if(matches.length!==1)return null;
  const match=matches[0],bytes=Buffer.from(view.frame.image.split(",")[1]??"","base64");
  if(createHash("sha256").update(bytes).digest("hex")!==match.frameSha256)return null;
  return match;
}
