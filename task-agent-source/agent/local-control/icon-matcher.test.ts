import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {makeIconTemplate,matchIconTemplate} from "./icon-matcher";
import {currentAppIcon,iconResolver} from "./icon-library";
import type {LocalView} from "./executor";

async function fixture(){
  const raw=Buffer.alloc(36*36*3,220);
  for(let y=0;y<36;y++)for(let x=0;x<36;x++){
    const r=Math.hypot(x-18,y-18),dark=r>10&&r<14||Math.abs(x-y)<2&&r<10;
    if(dark)raw.fill(20,(y*36+x)*3,(y*36+x+1)*3);
  }
  const icon=await sharp(raw,{raw:{width:36,height:36,channels:3}}).png().toBuffer();
  const scene=async(points:Array<{left:number;top:number}>)=>sharp({create:{width:240,height:320,channels:3,background:"#333333"}})
    .composite(points.map(p=>({input:icon,...p}))).jpeg({quality:95}).toBuffer();
  const source=await scene([{left:48,top:48}]);
  const template=await makeIconTemplate(source,{label:"Unseen App",deviceId:"arm",sourceSequence:1,frame:{width:240,height:320},bounds:{left:48,top:48,width:36,height:36}});
  return {scene,template};
}
test("icon appearance relocates on the current image without using its original position",async()=>{
  const f=await fixture(),match=await matchIconTemplate(await f.scene([{left:132,top:180}]),f.template,{deviceId:"arm"});
  assert.ok(match&&!match.ambiguous);assert.ok(Math.abs(match.center.x-150)<5);assert.ok(Math.abs(match.center.y-198)<5);
});
test("duplicate or absent icons cannot produce an accepted target",async()=>{
  const f=await fixture();
  const duplicate=await matchIconTemplate(await f.scene([{left:36,top:48},{left:144,top:192}]),f.template,{deviceId:"arm"});
  assert.ok(!duplicate||duplicate.ambiguous);
  const absent=await matchIconTemplate(await f.scene([]),f.template,{deviceId:"arm"});assert.ok(!absent||absent.ambiguous);
});
test("another device or resolution cannot reuse an icon sample",async()=>{
  const f=await fixture(),bytes=await f.scene([]);
  await assert.rejects(matchIconTemplate(bytes,f.template,{deviceId:"other"}),/another device/);
  await assert.rejects(matchIconTemplate(await sharp(bytes).resize(120,160).toBuffer(),f.template,{deviceId:"arm"}),/dimensions/);
});
test("changed calibration, old frame ID and mismatched image invalidate reusable appearance evidence",async()=>{
  const f=await fixture(),fingerprint="a".repeat(64);
  const library={version:1 as const,deviceId:"arm",stage:"development" as const,calibrationFingerprint:fingerprint,templates:[f.template]};
  assert.throws(()=>iconResolver(library,"b".repeat(64)),/calibration changed/);
  const view={frame:{sequence:2,image:"data:image/jpeg;base64,AA=="},appIcons:[{label:"Unseen App",score:.99,runnerUpScore:.1,ambiguous:false,
    frameSequence:1,frameSha256:"0".repeat(64),calibrationFingerprint:fingerprint}]} as unknown as LocalView;
  assert.equal(currentAppIcon(view,"Unseen App",fingerprint),null);
  view.appIcons![0].frameSequence=2;assert.equal(currentAppIcon(view,"Unseen App",fingerprint),null);
});
