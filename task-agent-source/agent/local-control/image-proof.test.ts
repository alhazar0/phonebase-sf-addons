import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { prepareImageProof,selectEffectRegion } from "./image-proof";
import type { LocalView } from "./executor";
import type { VisualTarget } from "./visual-target";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";

const profile:ScreenHandCalibrationProfile={id:"fixture",deviceId:"arm",verified:true,verifiedAt:"2026-09-07T00:00:00Z",
  frame:{width:720,height:1280},screen:{width:720,height:1280},imagePoints:[{x:0,y:0},{x:720,y:0},{x:720,y:1280},{x:0,y:1280}],
  machinePoints:[{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}],safeMachineBounds:{minimumX:9,maximumX:71,minimumY:19,maximumY:161},
  tap:{hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}};
const target:VisualTarget={role:"control",label:"round",confidence:.99,shape:"filled_circle",tone:"light",shapeScore:.99,
  center:{x:360,y:900},bounds:{left:315,top:855,width:90,height:90},source:"local_edges",edgeDensity:.5,localContrast:200};
async function fixture(right=false) {
  const x=right?500:140,stamp=Date.now();
  const thumb={...target,label:"image",center:{x:x+36,y:900},bounds:{left:x,top:864,width:72,height:72}};
  async function raster(pattern:"old"|"new"|"flat") {
    const fill=pattern==="flat"?"#080808":"#cccccc";
    const stripes=pattern==="flat"?"":Array.from({length:6},(_,i)=>pattern==="old"?
      `<rect x="${x+i*12}" y="864" width="6" height="72" fill="#444"/>`:
      `<rect x="${x}" y="${864+i*12}" width="72" height="6" fill="#444"/>`).join("");
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#080808"/><rect x="${x}" y="864" width="72" height="72" fill="${fill}"/>${stripes}<circle cx="360" cy="900" r="40" fill="white"/></svg>`)).jpeg({quality:95}).toBuffer();
  }
  const old=await raster("old"),changed=await raster("new"),flat=await raster("flat");
  function view(bytes:Buffer,sequence=1,ms=0):LocalView {
    const capturedAt=stamp+ms;
    return {deviceId:"arm",frame:{...profile.frame,image:"data:image/jpeg;base64,"+bytes.toString("base64"),sequence,capturedAt},
      state:{page:"unknown",source:"insufficient_evidence",overlay:"none",keyboard:false,candidates:[],evidence:[],stableFrames:1,method:"local-feature-rules+temporal",scoreIsProbability:false},
      elements:["Mode","Ready"].map((text,i)=>({id:String(i),role:"text",text,confidence:1,center:{x:300+i*80,y:800},bounds:{left:280+i*80,top:790,width:40,height:20}})),
      affordances:[target,thumb],visual:{targets:[target],accentText:["Mode"]},
      timing:{fetchMs:1,observationMs:1,ocrMs:1,ocrCacheHit:false,ocrCapturedAt:capturedAt,ocrAgeMs:0,stateMs:0,totalMs:1,frameAgeMs:0}};
  }
  return {old,changed,flat,view,thumb,side:right?"right_of_target" as const:"left_of_target" as const};
}
test("effect ROI follows the current neighboring image, not the whole empty band or a fixed phone position",async()=>{
  for(const right of [false,true]) {
    const f=await fixture(right),v=f.view(f.old),r=selectEffectRegion(v,target,f.side,profile);
    assert.ok(r.width<60&&r.height<60);assert.ok(r.left>f.thumb.bounds.left&&r.left+r.width<f.thumb.bounds.left+72);
    const verify=await prepareImageProof(v,target,f.side,profile);
    assert.equal((await verify(f.view(f.changed,2,100))).met,false);
    assert.equal((await verify(f.view(f.changed,3,350))).met,false);
    const result=await verify(f.view(f.changed,4,650));assert.equal(result.met,true);assert.equal(result.storageVerified,false);assert.equal(result.reason,"persistent_change");
    assert.ok(result.residualDifference>6);assert.notEqual(result.baselineHash,result.currentHash);
  }
});
test("unchanged image, brightness/gain changes and a flat occlusion are not new image content",async()=>{
  const f=await fixture();
  const bright=await sharp(f.old).linear(.75,30).jpeg({quality:95}).toBuffer();
  for(const pixels of [f.old,bright,f.flat]) {
    const verify=await prepareImageProof(f.view(f.old),target,f.side,profile);
    let result;for(let i=1;i<=5;i++)result=await verify(f.view(pixels,i+1,i*300));
    assert.equal(result!.met,false);
  }
});
test("short visual transients, duplicate or cached frames cannot accumulate a successful result",async()=>{
  const f=await fixture(),verify=await prepareImageProof(f.view(f.old),target,f.side,profile);
  assert.equal((await verify(f.view(f.changed,2,100))).met,false);
  assert.equal((await verify(f.view(f.changed,3,300))).met,false);
  assert.equal((await verify(f.view(f.old,4,600))).met,false);
  await assert.rejects(verify(f.view(f.changed,4,700)),/independent/);
  const cached=f.view(f.changed,5,900);cached.timing.ocrCacheHit=true;
  await assert.rejects(verify(cached),/independent/);
});
test("camera/text layout drift blocks apparent content changes",async()=>{
  const f=await fixture(),verify=await prepareImageProof(f.view(f.old),target,f.side,profile);
  let result;for(let i=1;i<=4;i++) {
    const v=f.view(f.changed,i+1,i*300);v.elements.forEach(e=>e.center.x+=20);result=await verify(v);
  }
  assert.equal(result!.met,false);assert.equal(result!.reason,"layout_moved");
});
test("absent, ambiguous or textureless evidence is rejected before a primary action can be submitted",async()=>{
  const f=await fixture(),missing=f.view(f.old);missing.affordances=[target];
  await assert.rejects(prepareImageProof(missing,target,f.side,profile),/found 0/);
  const ambiguous=f.view(f.old);ambiguous.affordances!.push({...f.thumb,center:{x:250,y:900},bounds:{left:220,top:870,width:60,height:60}});
  await assert.rejects(prepareImageProof(ambiguous,target,f.side,profile),/found 2/);
  await assert.rejects(prepareImageProof(f.view(f.flat),target,f.side,profile),/texture/);
});
