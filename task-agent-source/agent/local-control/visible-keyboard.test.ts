import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { readVisibleKeyboard,typeVisibleText,keyboardContentBoundary } from "./visible-keyboard";
import type { LocalView } from "./executor";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";
const profile:ScreenHandCalibrationProfile={id:"fixture",deviceId:"arm",verified:true,verifiedAt:"2026-09-07",frame:{width:720,height:1280},screen:{width:720,height:1280},
  imagePoints:[{x:0,y:0},{x:720,y:0},{x:720,y:1280},{x:0,y:1280}],machinePoints:[{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}],
  safeMachineBounds:{minimumX:9,maximumX:71,minimumY:19,maximumY:161},tap:{hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}};
async function fixture(upper=false,caps=true):Promise<LocalView> {
  const elements:LocalView["elements"]=[],rects:string[]=[];
  const add=(text:string,x:number,y:number)=>elements.push({id:`k${elements.length}`,role:"text",text,confidence:1,center:{x,y},bounds:{left:x-8,top:y-12,width:16,height:24}});
  ["qwertyuiop","asdfghjkl","zxcvbnm"].forEach((row,r)=>[...row].forEach((key,i)=>{
    const x=145+([0,.5,1.5][r]+i)*45,y=800+r*60;add(upper?key.toUpperCase():key,x,y);
    if(caps)rects.push(`<rect x="${x-18}" y="${y-22}" width="36" height="44" rx="3" fill="#555"/>`);
  }));
  add("123",170,990);add("space",365,990);
  const bytes=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="black"/>${rects.join("")}</svg>`)).jpeg().toBuffer(),now=Date.now();
  return {deviceId:"arm",frame:{...profile.frame,sequence:1,capturedAt:now,image:`data:image/jpeg;base64,${bytes.toString("base64")}`},elements,
    state:{page:"search",source:"current_evidence",overlay:"none",keyboard:true,candidates:[],evidence:[],stableFrames:2,method:"local-feature-rules+temporal",scoreIsProbability:false},
    timing:{fetchMs:0,observationMs:0,ocrMs:0,ocrCacheHit:false,ocrCapturedAt:now,ocrAgeMs:0,stateMs:0,totalMs:0,frameAgeMs:0}};
}
test("current QWERTY rows and key caps establish all letters, space and case without saved key coordinates",async()=>{
  for(const upper of [false,true]){
    const v=await fixture(upper);v.elements=v.elements.filter(e=>!['i','k','x'].includes(e.text.toLowerCase()));
    const layout=await readVisibleKeyboard(v,profile,undefined,true);
    assert.equal(layout.mode,"letters");assert.equal(layout.uppercase,upper);
    assert.equal(layout.keys.q.x,145);assert.equal(layout.keys.m.x,482.5);
    assert.equal(layout.keys.i.x,460); // OCR omitted i; the current row and cap locate it.
    assert.ok(layout.keys.space);assert.ok(layout.keys["123"]);
  }
});
test("text labels without key caps, shifted rows, stale frames and overlays cannot become key locations",async()=>{
  await assert.rejects(readVisibleKeyboard(await fixture(false,false),profile,undefined,true),/key-cap/);
  for(const mutate of [(v:LocalView)=>{v.elements[2].center.x+=30;},(v:LocalView)=>{v.timing.ocrCacheHit=true;},
    (v:LocalView)=>{v.state.overlay="dialog";},(v:LocalView)=>{v.frame.capturedAt=1;}]) {
    const v=await fixture();mutate(v);await assert.rejects(readVisibleKeyboard(v,profile,undefined,true));
  }
});
test("typing rejects form submission characters before observing or sending any action",async()=>{
  let calls=0;
  const deps={deviceId:"arm",observe:async()=>{calls++;return fixture();},getDevice:async()=>{throw new Error("unexpected");},getCalibration:async()=>profile,act:async()=>{throw new Error("unexpected");}};
  await assert.rejects(typeVisibleText(deps,"hello\n",AbortSignal.timeout(1000)),/never Enter/);assert.equal(calls,0);
});

test('prediction words are excluded from field targeting without excluding a search field when predictions are absent',async()=>{
  const v=await fixture(),k=await readVisibleKeyboard(v,profile,undefined,true);
  const item=(text:string,x:number,id:string)=>({id,role:'text' as const,text,confidence:1,center:{x,y:748},bounds:{left:x-20,top:738,width:40,height:20}});
  v.elements.push(item('alex',220,'prediction'),item('Alex',440,'prediction2'));
  assert.ok(keyboardContentBoundary(v,k)<738);
  v.elements=v.elements.filter(e=>!e.id.startsWith('prediction'));v.elements.push(item('Q Search',330,'search'));
  assert.ok(keyboardContentBoundary(v,k)>758);
});

test("an OCR-missed phone zero needs both the observed 3x3 grid and a real bottom key cap",async()=>{
  for(const cap of [false,true]){
    const v=await fixture();v.elements=[];
    for(let n=1;n<=9;n++){const x=210+((n-1)%3)*154,y=810+Math.floor((n-1)/3)*62;v.elements.push({id:String(n),role:'text',text:String(n),confidence:1,center:{x,y},bounds:{left:x-10,top:y-12,width:20,height:24}});}
    const bytes=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#555"/>${cap?'<rect x="294" y="972" width="140" height="48" fill="#bbb"/>':''}</svg>`)).jpeg().toBuffer();
    v.frame.image=`data:image/jpeg;base64,${bytes.toString('base64')}`;
    const layout=await readVisibleKeyboard(v,profile,undefined,true);
    assert.equal(!!layout.keys['0'],cap);
    if(cap)assert.deepEqual(layout.keys['0'],{x:364,y:996});
  }
});

test('resumed typing verifies the existing prefix and presses only the remaining keys',async()=>{
  let presses=0;const prefixes:string[]=[];
  const v=await fixture();
  const deps={deviceId:'arm',observe:async()=>({...v,frame:{...v.frame,capturedAt:Date.now()}}),getCalibration:async()=>profile,
    getDevice:async()=>({id:'arm',connected:true,status:'running',screen:null,state:{grbl:{homed:true,state:'Idle'}},capabilities:{actions:{tap:{available:true}}}}),
    act:async()=>{presses++;return {receipt:{id:'key',status:'completed' as const},elapsedMs:1,response:{}};}};
  const r=await typeVisibleText(deps,'hi',AbortSignal.timeout(2000),{initialPrefix:'h',readKeyboard:async()=>({mode:'letters',keys:{i:{x:400,y:800}},uppercase:false,top:780,pitch:40,anchors:26}),verifyPrefix:async(_v,p)=>{prefixes.push(p);}});
  assert.equal(r.status,'typed_unverified');assert.equal(presses,1);assert.deepEqual(prefixes,['h']);assert.deepEqual(r.keys.map(k=>k.key),['i']);
});

test('short words use one bounded chunk without depending on ambiguous single-letter OCR',async()=>{
  const prefixes:string[]=[];let presses=0;const v=await fixture();
  const deps={deviceId:'arm',observe:async()=>({...v,frame:{...v.frame,capturedAt:Date.now()}}),getCalibration:async()=>profile,
    getDevice:async()=>({id:'arm',connected:true,status:'running',screen:null,state:{grbl:{homed:true,state:'Idle'}},capabilities:{actions:{tap:{available:true}}}}),
    act:async()=>{presses++;return {receipt:{id:'key',status:'completed' as const},elapsedMs:1,response:{}};}};
  const r=await typeVisibleText(deps,'hi',AbortSignal.timeout(2000),{verifyEvery:4,readKeyboard:async()=>({mode:'letters',keys:{h:{x:360,y:860},i:{x:400,y:800}},uppercase:false,top:780,pitch:40,anchors:26}),verifyPrefix:async(_v,p)=>{prefixes.push(p);if(p==='h')throw new Error('caret obscures a single character');}});
  assert.equal(r.status,'typed_unverified');assert.equal(presses,2);assert.deepEqual(prefixes,['']);
});
