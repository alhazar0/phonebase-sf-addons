import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {z} from "zod";
import type {ScreenHandCalibrationProfile} from "../calibration-profile";

const schema=z.object({version:z.literal(1),deviceId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  baseFingerprint:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["candidate","verified"]),
  measuredAt:z.string().datetime(),expiresAt:z.string().datetime(),
  fixedMount:z.object({confirmedAt:z.string().datetime(),confirmedBy:z.literal("operator")}).strict().optional(),
  frame:z.object({width:z.number().int().positive(),height:z.number().int().positive()}).strict(),
  cameraOffset:z.object({x:z.number().finite(),y:z.number().finite()}).strict(),
  evidence:z.array(z.string().min(1).max(500)).min(1).max(20)}).strict();
export type TouchAlignment=z.infer<typeof schema>;
export const baseCalibrationFingerprint=(p:ScreenHandCalibrationProfile)=>createHash("sha256").update(JSON.stringify(p)).digest("hex");
export async function readTouchAlignment(deviceId:string,allowCandidate=false):Promise<TouchAlignment|null> {
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(deviceId))throw new Error("Invalid alignment device");
  let bytes:Buffer;try{bytes=await readFile(resolve(".runtime/touch-alignment",`${deviceId}.json`));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  if(bytes.length>16000)throw new Error("Alignment record exceeds limit");
  const a=schema.parse(JSON.parse(bytes.toString("utf8")));
  if(a.deviceId!==deviceId||a.status!=="verified"&&!allowCandidate)throw new Error("Touch alignment is awaiting hardware acceptance");
  return a;
}
/** Per-fixture contact-plane correction. The stable control plane is unchanged.
 * Translating camera reference points is equivalent to correcting the requested
 * pixel before mapping it once into the control plane's logical viewport. */
export function alignedCalibration(p:ScreenHandCalibrationProfile|null,a:TouchAlignment|null):ScreenHandCalibrationProfile|null {
  if(!p||!a)return p;
  if(a.deviceId!==p.deviceId||a.baseFingerprint!==baseCalibrationFingerprint(p)||a.frame.width!==p.frame.width||a.frame.height!==p.frame.height)
    throw new Error("Touch alignment does not match this device/calibration/frame; remeasure instead of reusing it");
  const now=Date.now(),measuredAt=Date.parse(a.measuredAt);
  if(!Number.isFinite(measuredAt)||measuredAt>now+1000)throw new Error("Touch alignment expired or has an invalid clock");
  // An operator may retain an accepted alignment for an unchanged fixed fixture.
  // Keep the original measurement/expiry as history; all geometry gates still apply.
  if(a.fixedMount){
    const confirmedAt=Date.parse(a.fixedMount.confirmedAt);
    if(a.status!=="verified"||a.fixedMount.confirmedBy!=="operator"||!Number.isFinite(confirmedAt)||confirmedAt<measuredAt||confirmedAt>now+1000)
      throw new Error("Fixed-mount alignment requires a valid operator confirmation of a verified measurement");
  }else if(!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<=now)throw new Error("Touch alignment expired or has an invalid clock");
  if(Math.abs(a.cameraOffset.x)>p.frame.width*.04||Math.abs(a.cameraOffset.y)>p.frame.height*.04)throw new Error("Touch alignment exceeds the bounded residual range; full calibration required");
  return {...p,id:`${p.id}:contact-aligned`,imagePoints:p.imagePoints.map(q=>({x:q.x-a.cameraOffset.x,y:q.y-a.cameraOffset.y})) as ScreenHandCalibrationProfile["imagePoints"]};
}
