import test from "node:test";import assert from "node:assert/strict";
import {alignedCalibration,baseCalibrationFingerprint,type TouchAlignment} from "./touch-alignment";
import {cameraToScreen} from "./geometry";
import type {ScreenHandCalibrationProfile} from "../calibration-profile";
const p={id:"base",deviceId:"arm",verified:true,frame:{width:720,height:1280},screen:{width:720,height:1560},imagePoints:[{x:100,y:100},{x:620,y:100},{x:620,y:1180},{x:100,y:1180}]} as ScreenHandCalibrationProfile;
const a=():TouchAlignment=>({version:1,deviceId:"arm",baseFingerprint:baseCalibrationFingerprint(p),status:"verified",measuredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),frame:p.frame,cameraOffset:{x:10,y:20},evidence:["test"]});
test("contact compensation maps once and never mutates the stable profile",()=>{
  const before=structuredClone(p),next=alignedCalibration(p,a())!;
  const actual=cameraToScreen(next,{x:300,y:400}),expected=cameraToScreen(p,{x:310,y:420});
  assert.ok(Math.abs(actual.x-expected.x)<1e-7&&Math.abs(actual.y-expected.y)<1e-7);assert.deepEqual(p,before);
  assert.equal(alignedCalibration(p,null),p);
});
test("another phone, changed profile/resolution, expiry or excessive residual cannot inherit compensation",()=>{
  for(const bad of [{...a(),deviceId:"other"},{...a(),baseFingerprint:"0".repeat(64)},{...a(),frame:{width:1280,height:720}},
    {...a(),expiresAt:new Date(0).toISOString()},{...a(),cameraOffset:{x:100,y:0}}])assert.throws(()=>alignedCalibration(p,bad));
});
test("operator-confirmed fixed mounting retains verified compensation after time expiry",()=>{
  const original=a();
  const fixed={...original,expiresAt:new Date(0).toISOString(),fixedMount:{confirmedAt:new Date().toISOString(),confirmedBy:"operator" as const}};
  assert.deepEqual(alignedCalibration(p,fixed),alignedCalibration(p,original));
  assert.equal(fixed.expiresAt,new Date(0).toISOString());
});
test("fixed mounting still rejects changed geometry, unverified measurements and invalid confirmation clocks",()=>{
  const fixed={...a(),expiresAt:new Date(0).toISOString(),fixedMount:{confirmedAt:new Date().toISOString(),confirmedBy:"operator" as const}};
  for(const bad of [
    {...fixed,deviceId:"other"},{...fixed,baseFingerprint:"0".repeat(64)},
    {...fixed,frame:{width:1280,height:720}},{...fixed,cameraOffset:{x:100,y:0}},
    {...fixed,status:"candidate" as const},{...fixed,measuredAt:new Date(Date.now()+60_000).toISOString()},
    {...fixed,fixedMount:{...fixed.fixedMount,confirmedAt:new Date(0).toISOString()}},
    {...fixed,fixedMount:{...fixed.fixedMount,confirmedAt:new Date(Date.now()+60_000).toISOString()}},
  ])assert.throws(()=>alignedCalibration(p,bad));
});
