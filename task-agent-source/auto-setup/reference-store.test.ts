import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { parseScreenHandCalibrationProfile } from "../agent/calibration-profile";
import { calibrationFingerprint, type AutoSetupReference } from "./core";
import { materializeCompatibleReference, readStoredReference, resolveSetupReference } from "./reference-store";

async function fixture(t: {after:(fn:()=>Promise<unknown>)=>void}) {
  const root=await mkdtemp(resolve(tmpdir(),"screenhand-reference-reuse-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const previousDirectory=resolve(root,"stable"),localDirectory=resolve(root,"experimental");
  await mkdir(previousDirectory);
  const profile=parseScreenHandCalibrationProfile({id:"calibration-v1",deviceId:"arm-02",verified:true,verifiedAt:"2026-09-05T00:00:00Z",frame:{width:720,height:1280},screen:{width:720,height:1560},imagePoints:[{x:100,y:100},{x:620,y:100},{x:620,y:1180},{x:100,y:1180}],machinePoints:[{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}],safeMachineBounds:{minimumX:9,maximumX:71,minimumY:19,maximumY:161},tap:{hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}});
  const bytes=await sharp({create:{width:720,height:1280,channels:3,background:"white"}}).jpeg().toBuffer();
  const reference:AutoSetupReference={version:2,deviceId:profile.deviceId,calibrationId:profile.id,capturedAt:"2026-09-05T00:00:00Z",baselineCalibrationSha256:calibrationFingerprint(profile),authorizedCalibrationSha256:calibrationFingerprint(profile),frame:{width:720,height:1280,sequence:10,sha256:createHash("sha256").update(bytes).digest("hex")},calibration:profile};
  const save=async (directory=previousDirectory, value=reference)=>{await mkdir(directory,{recursive:true});await writeFile(resolve(directory,"arm-02.json"),JSON.stringify(value));await writeFile(resolve(directory,"arm-02.jpg"),bytes);};
  await save();
  return {root,previousDirectory,localDirectory,profile,bytes,reference,save,input:{previousDirectory,localDirectory,profile,deviceId:profile.deviceId}};
}

test("matching previous reference is read-only during lookup",async t=>{
  const f=await fixture(t);const r=await resolveSetupReference(f.input);assert.equal(r.reuse.status,"compatible");assert.equal(r.saved?.reference.calibrationId,f.profile.id);assert.equal(await readStoredReference(f.localDirectory,"arm-02"),null);
});
test("confirmed materialization copies locally and never changes the source",async t=>{
  const f=await fixture(t);const source=await readFile(resolve(f.previousDirectory,"arm-02.json"));
  assert.equal(await materializeCompatibleReference(f.input),true);assert.equal(await materializeCompatibleReference(f.input),false);
  assert.deepEqual(await readFile(resolve(f.previousDirectory,"arm-02.json")),source);assert.deepEqual((await readStoredReference(f.localDirectory,"arm-02"))?.bytes,f.bytes);
});
test("different calibration ID or authorized fingerprint cannot be imported",async t=>{
  const f=await fixture(t);
  for(const profile of [{...f.profile,id:"new-calibration"},{...f.profile,tap:{...f.profile.tap,touchZ:10}}]) {
    const input={...f.input,profile};const r=await resolveSetupReference(input);assert.equal(r.reuse.status,"incompatible");assert.equal(r.saved,null);await assert.rejects(materializeCompatibleReference(input),/compatible/);
  }
  assert.equal(await readStoredReference(f.localDirectory,"arm-02"),null);
});
test("corrupt previous image and metadata fail closed without writes",async t=>{
  const f=await fixture(t);await writeFile(resolve(f.previousDirectory,"arm-02.jpg"),"corrupt");
  const r=await resolveSetupReference(f.input);assert.equal(r.reuse.status,"incompatible");assert.match(r.reuse.reason,/integrity/);assert.equal(r.saved,null);
});
test("wrong reference device is not silently reassigned",async t=>{
  const f=await fixture(t);await f.save(f.previousDirectory,{...f.reference,deviceId:"arm-01"});
  const r=await resolveSetupReference(f.input);assert.equal(r.reuse.status,"incompatible");assert.match(r.reuse.reason,/another device/);
});
test("local reference takes priority; corrupt local state cannot fall back silently",async t=>{
  const f=await fixture(t);await f.save(f.localDirectory);assert.equal((await resolveSetupReference(f.input)).reuse.status,"local");
  await writeFile(resolve(f.localDirectory,"arm-02.json"),"invalid-json");await assert.rejects(resolveSetupReference(f.input));
});
test("missing sources and invalid IDs remain non-mutating",async t=>{
  const f=await fixture(t);const r=await resolveSetupReference({...f.input,previousDirectory:resolve(f.root,"missing")});assert.equal(r.reuse.status,"missing");
  const disabled=await resolveSetupReference({...f.input,previousDirectory:undefined});assert.equal(disabled.reuse.status,"disabled");
  await assert.rejects(readStoredReference(f.previousDirectory,"../arm-02"),/Invalid/);
});
test("a missing image is not mistaken for a never-configured local reference",async t=>{
  const f=await fixture(t);await mkdir(f.localDirectory);await writeFile(resolve(f.localDirectory,"arm-02.json"),JSON.stringify(f.reference));await assert.rejects(resolveSetupReference(f.input));
});
