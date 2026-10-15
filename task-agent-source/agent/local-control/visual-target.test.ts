import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { extractVisualFeatures, selectVisualTarget, hasYellowText } from "./visual-target";
import { detectVisualAffordances } from "../visual-affordance-detector";
import { LocalClosedLoopExecutor, type LocalView } from "./executor";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import { requestSchema } from "./contract";
import { taskPlanSchema, taskPlanningDocument, TextTaskPlanner, decodeWirePlan } from "./task-planner";
import { LocalVisualTaskRunner } from "./task-runner";

const profile:ScreenHandCalibrationProfile={id:"test",deviceId:"arm",verified:true,verifiedAt:"2026-09-07T00:00:00Z",
  frame:{width:720,height:1280},screen:{width:720,height:1280},imagePoints:[{x:0,y:0},{x:720,y:0},{x:720,y:1280},{x:0,y:1280}],
  machinePoints:[{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}],safeMachineBounds:{minimumX:9,maximumX:71,minimumY:19,maximumY:161},
  tap:{hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}};
async function raster(content:string,background="#080808") {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="${background}"/>${content}</svg>`)).jpeg({quality:90}).toBuffer();
}
async function view(bytes:Buffer,sequence=1):Promise<LocalView> {
  const now=Date.now();const detected=await detectVisualAffordances(bytes,{viewport:profile.frame});
  return {deviceId:"arm",frame:{...profile.frame,sequence,capturedAt:now,image:"data:image/jpeg;base64,"+bytes.toString("base64")},affordances:detected.candidates,
    state:{page:"unknown",source:"insufficient_evidence",overlay:"none",keyboard:false,candidates:[],evidence:[],stableFrames:1,method:"local-feature-rules+temporal",scoreIsProbability:false},
    timing:{fetchMs:1,observationMs:1,ocrMs:1,ocrCacheHit:false,ocrCapturedAt:now,ocrAgeMs:0,stateMs:0,totalMs:1,frameAgeMs:0},
    elements:["Mode","Ready"].map((text,i)=>({id:`t${i}`,role:"text",text,confidence:1,center:{x:330+i*70,y:850},bounds:{left:310+i*70,top:830,width:50,height:30}}))};
}

test("filled-circle features survive position, size and contrast polarity changes",async()=>{
  for(const [x,y,r] of [[200,500,38],[520,940,46],[360,700,60]])for(const dark of [false,true]) {
    const v=await view(await raster(`<circle cx="${x}" cy="${y}" r="${r}" fill="${dark?"#050505":"#fafafa"}"/>`,dark?"#f0f0f0":"#050505"));
    v.visual=await extractVisualFeatures(v,profile);
    const t=selectVisualTarget({shape:"filled_circle",tone:dark?"dark":"light"},v,profile);
    assert.ok(Math.abs(t.center.x-x)<8&&Math.abs(t.center.y-y)<8);
  }
});
test("flat images, squares, hollow rings and plus symbols are not solid round controls",async()=>{
  for(const shape of ["",'<rect x="310" y="650" width="100" height="100" fill="white"/>',
    '<circle cx="360" cy="700" r="45" fill="none" stroke="white" stroke-width="5"/>',
    '<path d="M320 700H400M360 660V740" stroke="white" stroke-width="8"/>']) {
    const v=await view(await raster(shape));const f=await extractVisualFeatures(v,profile);
    assert.equal(f.targets.some(t=>t.shape==="filled_circle"),false);
  }
});
test("camera glyph is a visual template, not a remembered phone position",async()=>{
  for(const [x,y,size] of [[160,300,90],[470,700,120]]) {
    const v=await view(await raster(`<g transform="translate(${x} ${y}) scale(${size/90})"><rect width="90" height="90" rx="14" fill="#ddd"/>
      <rect x="14" y="26" width="62" height="39" rx="5" fill="#080808"/><rect x="46" y="20" width="18" height="12" rx="3" fill="#080808"/>
      <circle cx="44" cy="45" r="13" fill="#101010" stroke="#eee" stroke-width="3"/></g>`));
    v.visual=await extractVisualFeatures(v,profile);
    const target=selectVisualTarget({shape:"camera_glyph"},v,profile);
    assert.ok(target.center.x>x&&target.center.x<x+size&&target.center.y>y&&target.center.y<y+size);
  }
});
test("ambiguous circles do not become a guessed tap; current text relations can disambiguate",async()=>{
  const v=await view(await raster('<circle cx="360" cy="960" r="40" fill="white"/><circle cx="560" cy="960" r="40" fill="white"/>'));
  v.visual=await extractVisualFeatures(v,profile);
  assert.throws(()=>selectVisualTarget({shape:"filled_circle"},v,profile),/found 2/);
  assert.ok(selectVisualTarget({shape:"filled_circle",anchor:{text:"Mode",relation:"below"}},v,profile).center.x<400);
  assert.throws(()=>selectVisualTarget({shape:"filled_circle",anchor:{text:"Missing",relation:"below"}},v,profile),/anchor/);
});

test("visual effect requires changed, stable neighboring pixels; identical frames never cause a second action",async()=>{
  const base='<circle cx="360" cy="960" r="40" fill="white"/><rect x="150" y="930" width="60" height="60" fill="#ccc"/>';
  const before=await raster(base+Array.from({length:5},(_,i)=>`<rect x="${150+i*12}" y="930" width="6" height="60" fill="#444"/>`).join(""));
  const changed=await raster(base+Array.from({length:5},(_,i)=>`<rect x="150" y="${930+i*12}" width="60" height="6" fill="#444"/>`).join(""));
  for(const success of [true,false]) {
    let observations=0,actions=0;
    const executor=new LocalClosedLoopExecutor({deviceId:"arm",getCalibration:async()=>profile,
      getDevice:async()=>({id:"arm",connected:true,status:"running",screen:null,state:{grbl:{homed:true,state:"Idle"}},capabilities:{actions:{tap:{available:true}}}}),
      observe:async()=>{observations++;return view(observations>1&&success?changed:before,observations);},
      act:async()=>{actions++;return {receipt:{id:"one",status:"completed"},elapsedMs:1,response:{}};}});
    const r=await executor.run({intent:{type:"tap_visual",selector:{shape:"filled_circle",tone:"light"}},
      require:{textAll:["Mode","Ready"],overlay:"none"},expect:{textAll:["Mode","Ready"],changedRegion:"left_of_target",overlay:"none"}},
      {execute:true,verificationMs:success?1500:500});
    assert.equal(r.status,success?"verified":"unverified",r.error);assert.equal(actions,1);
  }
});

test("contracts reject unguarded visuals, coordinates, two primary actions and fake completion",()=>{
  assert.equal(requestSchema.safeParse({intent:{type:"tap_visual",selector:{shape:"filled_circle"}},expect:{textAll:["Ready"]}}).success,false);
  const step={intent:{type:"tap_visual",selector:{shape:"filled_circle"}},require:{textAll:["Mode","Ready"],accentText:["Mode"],overlay:"none"},expect:{textAll:["Mode","Ready"],changedRegion:"left_of_target"}};
  assert.equal(taskPlanSchema.safeParse({steps:[step],unsupportedReason:null}).success,true);
  assert.equal(taskPlanSchema.safeParse({steps:[step,step],unsupportedReason:null}).success,false);
  assert.equal(taskPlanSchema.safeParse({steps:[{...step,intent:{...step.intent,point:{x:1,y:2}}}],unsupportedReason:null}).success,false);
  assert.equal(taskPlanSchema.safeParse({steps:[{...step,expect:{textAll:["Mode"]}}],unsupportedReason:null}).success,false);
});
test("task planner sends one bounded text request and no camera images or coordinates",async()=>{
  const v=await view(await raster(""));let calls=0;
  const wire={steps:[{action:"home",text:null,shape:null,tone:null,anchor:null,relation:null,beforeTexts:[],beforeAccent:[],afterTexts:["Settings","Clock"],afterAccent:[],changedRegion:null}],unsupportedReason:null};
  const plan=decodeWirePlan(wire);
  const planner=new TextTaskPlanner("test-secret",async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.equal(body.model,"google/gemini-3.8-flash");
    assert.equal(body.provider.zdr,true);assert.doesNotMatch(JSON.stringify(body),/data:image|image_url|test-secret/);
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(wire)}}]});
  });
  assert.deepEqual((await planner.plan("返回首页",v,AbortSignal.timeout(1000))).plan,plan);assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(taskPlanningDocument("返回首页",v)),/data:image/);
});

test("one task plans once, preview never moves, uncertain receipt stops the remaining sequence",async()=>{
  const bytes=await raster("");
  const plan=taskPlanSchema.parse({steps:[
    {intent:{type:"tap_text",text:"Mode"},expect:{textAll:["Destination","Title"]}},
    {intent:{type:"tap_text",text:"Destination"},expect:{textAll:["Finished","Title"]}},
  ],unsupportedReason:null});
  for(const mode of ["preview","success","uncertain"] as const) {
    let actions=0,observations=0,calls=0;
    const runtime=new LocalVisualTaskRunner({deviceId:"arm",getCalibration:async()=>profile,
      getDevice:async()=>({id:"arm",connected:true,status:"running",screen:null,state:{grbl:{homed:true,state:"Idle"}},capabilities:{actions:{tap:{available:true}}}}),
      observe:async()=>{const v=await view(bytes,++observations);if(actions)v.elements=v.elements.map((e,i)=>({...e,text:i?"Title":actions===1?"Destination":"Finished"}));return v;},
      act:async()=>{actions++;if(mode==="uncertain")throw new Error("Lost receipt");return {receipt:{id:`r${actions}`,status:"completed"},elapsedMs:1,response:{}};}},
    {plan:async()=>{calls++;return {plan,elapsedMs:1,model:"fake"};}});
    const result=await runtime.run("fixture task",{execute:mode!=="preview",signal:AbortSignal.timeout(3000)});
    assert.equal(result.status,mode==="preview"?"preview":mode==="success"?"verified":"action_uncertain",result.error);
    assert.equal(calls,1);assert.equal(result.modelCalls,1);assert.equal(actions,mode==="preview"?0:mode==="success"?2:1);
    assert.equal(result.cleanup,undefined);
  }
});
test("wire decoding does not smuggle visual actions or accept an unguarded primary effect",()=>{
  const step={action:"home",text:null,shape:null,tone:null,anchor:null,relation:null,beforeTexts:[],beforeAccent:[],afterTexts:["A","B"],afterAccent:[],changedRegion:null};
  assert.throws(()=>decodeWirePlan({steps:[{...step,shape:"filled_circle"}],unsupportedReason:null}),/visual fields/);
  assert.throws(()=>decodeWirePlan({steps:[{...step,action:"tap_visual",shape:"filled_circle"}],unsupportedReason:null}));
});
test("yellow strokes tolerate black OCR padding and dim light, but white text or a solid yellow patch do not",()=>{
  for(const color of [[180,165,110],[120,110,60],[195,195,195]]) {
    const p=Buffer.alloc(1000*3);for(let i=0;i<250;i++)p.set(color,i*3);
    assert.equal(hasYellowText(p),color[0]!==195);
  }
  assert.equal(hasYellowText(Buffer.from(Array.from({length:500},()=>[180,165,110]).flat())),false);
});
test("a merged text/control edge candidate is split using current intensity, not its wrong center",async()=>{
  const v=await view(await raster('<rect x="337" y="880" width="45" height="12" fill="white"/><circle cx="365" cy="970" r="37" fill="#ddd"/>'));
  v.affordances=[{role:"control",label:"merged",confidence:.9,center:{x:365,y:950},bounds:{left:310,top:870,width:110,height:155},source:"local_edges",edgeDensity:.4,localContrast:110}];
  v.visual=await extractVisualFeatures(v,profile);
  const t=selectVisualTarget({shape:"filled_circle"},v,profile);assert.ok(Math.abs(t.center.y-970)<2);
});
