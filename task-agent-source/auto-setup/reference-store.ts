import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { parseScreenHandCalibrationProfile, type ScreenHandCalibrationProfile } from "../agent/calibration-profile";
import { autoSetupReferenceIntegrityIssue, calibrationFingerprint, type AutoSetupReference } from "./core";

export type StoredReference = { reference: AutoSetupReference; bytes: Buffer };
export type ReferenceReuseInfo = {
  source: "current_version" | "previous_version" | "none";
  status: "local" | "compatible" | "incompatible" | "missing" | "disabled";
  reason: string;
  savedCalibrationId?: string;
  activeCalibrationId: string;
};

function paths(directory: string, deviceId: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(deviceId)) throw new Error("Invalid reference device ID");
  return {metadata:resolve(directory,`${deviceId}.json`),image:resolve(directory,`${deviceId}.jpg`)};
}

export async function readStoredReference(directory: string, deviceId: string): Promise<StoredReference | null> {
  const path=paths(directory,deviceId);
  let metadataText: string;
  try { metadataText=await readFile(path.metadata,"utf8"); }
  catch(error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") return null; throw error; }
  const bytes=await readFile(path.image);
  if (bytes.length>8_000_000) throw new Error("Reference image exceeds the allowed size");
  const raw=JSON.parse(metadataText) as AutoSetupReference;
  const reference={...raw,calibration:parseScreenHandCalibrationProfile(raw.calibration)};
  const issue=autoSetupReferenceIntegrityIssue({reference,expectedDeviceId:deviceId,imageSha256:createHash("sha256").update(bytes).digest("hex")});
  if (issue) throw new Error(issue);
  if (reference.calibration.deviceId!==deviceId || reference.calibrationId!==reference.calibration.id) throw new Error("Reference metadata and calibration identity disagree");
  const image=await sharp(bytes).metadata();
  if (image.width!==reference.frame.width || image.height!==reference.frame.height || image.width!==reference.calibration.frame.width || image.height!==reference.calibration.frame.height) throw new Error("Reference image and calibration dimensions disagree");
  return {reference,bytes};
}

export async function resolveSetupReference(input: {localDirectory:string;previousDirectory?:string;deviceId:string;profile:ScreenHandCalibrationProfile}): Promise<{saved:StoredReference|null;reuse:ReferenceReuseInfo}> {
  const local=await readStoredReference(input.localDirectory,input.deviceId);
  const base={activeCalibrationId:input.profile.id};
  if (local) return {saved:local,reuse:{...base,source:"current_version",status:"local",savedCalibrationId:local.reference.calibrationId,reason:"Using this version's saved visual reference; current camera registration is still required."}};
  if (!input.previousDirectory || resolve(input.previousDirectory)===resolve(input.localDirectory)) return {saved:null,reuse:{...base,source:"none",status:"disabled",reason:"No previous-version reference directory is configured."}};
  let previous:StoredReference|null;
  try { previous=await readStoredReference(input.previousDirectory,input.deviceId); }
  catch(error) { return {saved:null,reuse:{...base,source:"previous_version",status:"incompatible",reason:`The previous reference failed integrity validation: ${error instanceof Error?error.message:String(error)}. It has not been imported.`}}; }
  if (!previous) return {saved:null,reuse:{...base,source:"none",status:"missing",reason:"No saved reference for this device was found in either version."}};
  const reference=previous.reference;
  const detail={...base,source:"previous_version" as const,savedCalibrationId:reference.calibrationId};
  if (input.profile.deviceId!==input.deviceId || reference.calibrationId!==input.profile.id) return {saved:null,reuse:{...detail,status:"incompatible",reason:`Previous reference belongs to calibration '${reference.calibrationId}', but the active calibration is '${input.profile.id}'. Review the active corners; the previous reference has not been imported.`}};
  if (reference.authorizedCalibrationSha256!==calibrationFingerprint(input.profile)) return {saved:null,reuse:{...detail,status:"incompatible",reason:"The previous reference does not authorize the active calibration fingerprint. Review the active corners; nothing has been imported."}};
  return {saved:previous,reuse:{...detail,status:"compatible",reason:"A compatible previous-version reference was found read-only. Live camera registration must still pass; an explicit restore confirmation is required before saving a local copy."}};
}

/** Invoke only inside the existing confirmed Run mutation lock, never Preview. */
export async function materializeCompatibleReference(input: Parameters<typeof resolveSetupReference>[0]): Promise<boolean> {
  const selected=await resolveSetupReference(input);
  if (selected.reuse.status==="local") return false;
  if (selected.reuse.status!=="compatible" || !selected.saved) throw new Error("No compatible reference can be imported for this device");
  const destination=paths(input.localDirectory,input.deviceId);
  await mkdir(input.localDirectory,{recursive:true});
  const suffix=`.${randomUUID()}.tmp`;
  const metadata=destination.metadata+suffix,image=destination.image+suffix;
  try {
    await Promise.all([writeFile(metadata,JSON.stringify(selected.saved.reference,null,2)+"\n",{flag:"wx"}),writeFile(image,selected.saved.bytes,{flag:"wx"})]);
    await rename(image,destination.image);
    await rename(metadata,destination.metadata);
  } finally { await Promise.all([metadata,image].map(path=>unlink(path).catch(error=>{if(error.code!=="ENOENT")throw error;}))); }
  return true;
}
