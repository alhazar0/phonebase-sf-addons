import assert from "node:assert/strict";
import test from "node:test";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import type { AgentDevice } from "../general-agent-client";
import { assessExpectation, cameraToScreen, expectationMet, LocalClosedLoopExecutor, selectAction, type LocalView, validateGeometry } from "./executor";
import { requestSchema } from "./contract";

const profile: ScreenHandCalibrationProfile={id:"verified-fixture",deviceId:"arm",verified:true,verifiedAt:"2026-09-05T00:00:00Z",frame:{width:720,height:1280},screen:{width:720,height:1560},imagePoints:[{x:100,y:100},{x:620,y:100},{x:620,y:1180},{x:100,y:1180}],machinePoints:[{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}],safeMachineBounds:{minimumX:9,maximumX:71,minimumY:19,maximumY:161},tap:{hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}};
function view(sequence=1,texts=["Edit"]): LocalView {
  const capturedAt=Date.now();
  return {deviceId:"arm",frame:{sequence,capturedAt,width:720,height:1280,image:""},
    state:{page:"unknown",source:"insufficient_evidence",overlay:"none",keyboard:false,candidates:[],evidence:[],stableFrames:1,method:"local-feature-rules+temporal",scoreIsProbability:false},
    elements:texts.map((text,i)=>({id:String(i),role:"text",text,confidence:.99,center:{x:250+i*70,y:250},bounds:{left:230+i*70,top:240,width:40,height:20}})),
    timing:{fetchMs:1,observationMs:2,ocrMs:1,ocrCacheHit:false,ocrCapturedAt:capturedAt,ocrAgeMs:0,stateMs:0,totalMs:3,frameAgeMs:0}};
}
const request={intent:{type:"tap_text",text:"Edit"},expect:{textAll:["Done"],textAbsent:["Edit"]}};
function setup(options:{after?:(seq:number)=>LocalView;actFails?:boolean;homed?:boolean;calibrationChanges?:boolean;before?:LocalView}={}) {
  let actions=0,observations=0,calibrations=0;
  const device:AgentDevice={id:"arm",connected:true,status:"running",screen:null,state:{grbl:{connected:true,homed:options.homed ?? true,state:"Idle"}},capabilities:{actions:{tap:{available:true},swipe:{available:true},phone_key:{available:true},input_text:{available:false}}}};
  const executor=new LocalClosedLoopExecutor({deviceId:"arm",getDevice:async()=>device,
    getCalibration:async()=>{calibrations++;return options.calibrationChanges&&calibrations>1?{...profile,id:"different"}:profile;},
    observe:async()=>{observations++;return observations===1?(options.before??view(1)):options.after?.(observations)??view(observations,["Done"]);},
    act:async()=>{actions++;if(options.actFails)throw new Error("Receipt transport timed out");return {receipt:{id:"receipt",status:"completed"},elapsedMs:2,response:{}};}});
  return {executor,actions:()=>actions};
}
test("camera coordinates map to the logical screen once",()=>{
  const point=cameraToScreen(profile,{x:360,y:640});assert.ok(Math.abs(point.x-360)<1e-6);assert.ok(Math.abs(point.y-780)<1e-6);
  assert.throws(()=>cameraToScreen(profile,{x:10,y:10}),/outside/);
  const action=selectAction({type:"tap_text",text:"Edit"},view(),profile);assert.equal(action.type,"tap");
  if(action.type==="tap"){assert.deepEqual(action.viewport,profile.screen);assert.notEqual(action.point.x,250);}
});
test("invalid dimensions, profile device and crossed corner order stop mapping",()=>{
  assert.throws(()=>validateGeometry({...profile,frame:{width:640,height:480}},view()),/dimensions/);
  assert.throws(()=>validateGeometry({...profile,deviceId:"other"},view()),/another device/);
  assert.throws(()=>validateGeometry({...profile,imagePoints:[profile.imagePoints[0],profile.imagePoints[2],profile.imagePoints[1],profile.imagePoints[3]]},view()),/convex/);
});
test("ambiguous and fuzzy text do not produce a click",()=>{
  assert.throws(()=>selectAction({type:"tap_text",text:"Edit"},view(1,["Edit","Edit"]),profile),/found 2/);
  assert.throws(()=>selectAction({type:"tap_text",text:"Edlt"},view(),profile),/found 0/);
});
test("overlays block underlying targets unless explicitly targeted",()=>{
  const v=view();v.state.overlay="dialog";assert.throws(()=>selectAction({type:"tap_text",text:"Edit"},v,profile),/overlay/);
  assert.equal(selectAction({type:"tap_text",text:"Edit",allowOverlay:true},v,profile).type,"tap");
});
test("Home and typing require phone-specific verified configuration",()=>{
  assert.throws(()=>selectAction({type:"navigate",key:"home"},view(),profile),/Home strategy/);
  assert.throws(()=>selectAction({type:"input_text",text:"test"},view(),profile),/keyboard/);
});
test("a positive postcondition is mandatory",()=>{
  assert.equal(requestSchema.safeParse({intent:request.intent,expect:{textAbsent:["Edit"]}}).success,false);
  assert.equal(requestSchema.safeParse({intent:request.intent,expect:{overlay:"none"}}).success,false);
});
test("preview and already-satisfied goals never submit actions",async()=>{
  const a=setup();assert.equal((await a.executor.run(request)).status,"preview");assert.equal(a.actions(),0);
  const b=setup({before:view(1,["Done"])});assert.equal((await b.executor.run(request,{execute:true})).status,"already_satisfied");assert.equal(b.actions(),0);
});
test("unhomed device, stale frame, changed calibration and cached target stop before dispatch",async()=>{
  const stale=view();stale.frame.capturedAt-=5000;
  const cached=view();cached.timing.ocrCacheHit=true;
  for(const option of [{homed:false},{calibrationChanges:true},{before:stale},{before:cached}]){
    const f=setup(option);const r=await f.executor.run(request,{execute:true});assert.equal(r.status,"blocked");assert.equal(f.actions(),0);
  }
});
test("invalid timeout is rejected before action",async()=>{
  const f=setup();assert.equal((await f.executor.run(request,{execute:true,verificationMs:NaN})).status,"blocked");assert.equal(f.actions(),0);
});
test("two independent fresh post-action observations verify one physical submission",async()=>{
  const f=setup();const r=await f.executor.run(request,{execute:true,verificationMs:900});
  assert.equal(r.status,"verified");assert.equal(f.actions(),1);assert.ok(r.verificationSamples.length>=2);assert.ok(r.timing.totalMs>=r.timing.verificationMs);
});
test("unchanged screen is not success and is never tapped again",async()=>{
  const f=setup({after:s=>view(s,["Edit"])});const r=await f.executor.run(request,{execute:true,verificationMs:400});assert.equal(r.status,"unverified");assert.equal(f.actions(),1);
});
test("stable unexpected navigation returns actual evidence early but never claims the expected outcome",async()=>{
  const f=setup({after:seq=>view(seq,["Unexpected","Another page"])});
  const r=await f.executor.run(request,{execute:true,verificationMs:1500,returnOnStableChange:true});
  assert.equal(r.status,"unverified");assert.equal(f.actions(),1);
  assert.match(r.error!,/Actual page changed/);assert.ok(r.timing.verificationMs<1500);
  assert.deepEqual(r.after?.text,["Unexpected","Another page"]);
});
test("an explicitly allowed dialog action checks current text without requiring the dialog to vanish before acting",async()=>{
  const before=view(1,["Cancel","Permission request"]);before.state.overlay="dialog";
  const r={intent:{type:"tap_text",text:"Cancel",allowOverlay:true},require:{textAll:["Cancel","Permission request"]},expect:{textAll:["Done"],overlay:"none"}};
  const f=setup({before});const result=await f.executor.run(r,{execute:true,verificationMs:900});
  assert.equal(result.status,"verified");assert.equal(f.actions(),1);
  const g=setup({before});const blocked=await g.executor.run({...r,intent:{...r.intent,allowOverlay:false}},{execute:true});
  assert.equal(blocked.status,"blocked");assert.equal(g.actions(),0);
  const h=setup({before});const explicitNone=await h.executor.run({...r,require:{...r.require,overlay:"none"}},{execute:true});
  assert.equal(explicitNone.status,"blocked");assert.equal(h.actions(),0);
});
test("duplicate frames and cached OCR cannot prove a new state",async()=>{
  const fixed=view(1,["Done"]);
  for(const after of [()=>fixed,(seq:number)=>{const v=view(seq,["Done"]);v.timing.ocrCacheHit=true;return v;}]){
    const f=setup({after});const r=await f.executor.run(request,{execute:true,verificationMs:400});assert.equal(r.status,"unverified");assert.equal(f.actions(),1);
  }
});
test("camera sequence rollback fails verification",async()=>{
  const f=setup({after:()=>view(0,["Done"])});const r=await f.executor.run(request,{execute:true});assert.equal(r.status,"unverified");assert.match(r.error!,/restarted/);
});
test("uncertain command receipt is not retried or described as success",async()=>{
  const f=setup({actFails:true});const r=await f.executor.run(request,{execute:true});assert.equal(r.status,"action_uncertain");assert.equal(f.actions(),1);assert.equal(r.verificationSamples.length,0);
});
const exploration={intent:{type:"swipe",direction:"left"},require:{textAll:["Edit","Panel"],overlay:"none"}};
test("exploratory swipes observe unknown and unchanged screens, never verify an outcome",async()=>{
  for(const texts of [["New","Actual"],["Edit","Panel"]]){
    const f=setup({before:view(1,["Edit","Panel"]),after:s=>view(s,texts)});
    const r=await f.executor.run(exploration,{exploration:true,execute:true,verificationMs:900});
    assert.equal(r.status,"observed");assert.equal(r.verificationMode,"observe");assert.equal(r.verification,undefined);
    assert.deepEqual(r.after!.text,texts);assert.ok(r.verificationSamples.filter(s=>s.eligible).length>=2);assert.equal(f.actions(),1);
  }
});
test("an exploration result exposes a popup without clicking behind or dismissing it",async()=>{
  const f=setup({before:view(1,["Edit","Panel"]),after:s=>{const v=view(s,["Dialog","Close"]);v.state.overlay="dialog";return v;}});
  const r=await f.executor.run(exploration,{exploration:true,execute:true,verificationMs:900});
  assert.equal(r.status,"observed");assert.equal(r.after?.overlay,"dialog");assert.equal(f.actions(),1);
});
test("exploration keeps receipt, camera freshness, precondition and no-fallback gates",async()=>{
  const before=view(1,["Edit","Panel"]);
  const uncertain=setup({before,actFails:true});
  const r=await uncertain.executor.run(exploration,{exploration:true,execute:true});assert.equal(r.status,"action_uncertain");assert.equal(uncertain.actions(),1);
  const cached=setup({before,after:s=>{const v=view(s,["New","Page"]);v.timing.ocrCacheHit=true;return v;}});
  assert.equal((await cached.executor.run(exploration,{exploration:true,execute:true,verificationMs:400})).status,"unverified");
  for(const input of [{...exploration,intent:{type:"tap_text",text:"Edit"}},{...exploration,expect:{textAll:["Anything"]}}]){
    const f=setup({before});assert.equal((await f.executor.run(input,{exploration:true,execute:true})).status,"blocked");assert.equal(f.actions(),0);
  }
  const hidden=setup({before:view(1,["Other","Actual"])});
  assert.equal((await hidden.executor.run(exploration,{exploration:true,execute:true})).status,"blocked");assert.equal(hidden.actions(),0);
  const preview=setup({before});assert.equal((await preview.executor.run(exploration,{exploration:true})).status,"preview");assert.equal(preview.actions(),0);
});
test("abort before dispatch and simultaneous runs cannot submit extra actions",async()=>{
  const f=setup();const controller=new AbortController();controller.abort();assert.equal((await f.executor.run(request,{execute:true,signal:controller.signal})).status,"blocked");assert.equal(f.actions(),0);
  const first=f.executor.run(request);await assert.rejects(f.executor.run(request),/already running/);await first;
});

test("supporting text is observable but cannot establish success alone",()=>{
  assert.equal(requestSchema.safeParse({intent:request.intent,expect:{supportingText:["Done"]}}).success,false);
  for (const branch of [{}, {textAbsent:["Edit"]}, {overlay:"none"}]) {
    assert.equal(requestSchema.safeParse({intent:request.intent,expect:{anyOf:[branch]}}).success,false);
  }
  const assessment=assessExpectation({textAll:["Done"],supportingText:["Alarm"]},view(2,["Done"]),view(),profile);
  assert.equal(assessment.met,true);assert.deepEqual(assessment.supportingText,[{text:"Alarm",present:false}]);
});

test("recognized page plus title can verify without an unrelated bottom tab",()=>{
  const v=view(2,["World Clock","New York"]);
  v.state.page="clock";v.state.source="current_evidence";
  const expect={textAbsent:["Weather"],anyOf:[{page:"clock" as const,textAll:["World Clock"]}],supportingText:["Alarm"]};
  assert.equal(expectationMet(expect,v,view(),profile),true);
  assert.equal(expectationMet({textAll:["World Clock","Alarm"]},v,view(),profile),false,"legacy required text remains required");
  v.state.source="recent_context";
  assert.equal(expectationMet(expect,v,view(),profile),false,"remembered page is not current evidence");
});

test("matching page alternatives never override missing mandatory editing state",()=>{
  const v=view(2,["World Clock"]);v.state.page="clock";v.state.source="current_evidence";
  const a=assessExpectation({textAll:["Done"],anyOf:[{page:"clock"}]},v,view(),profile);
  assert.equal(a.met,false);assert.equal(a.alternatives[0].met,true);
  assert.deepEqual(a.checks,[{condition:"text present: Done",met:false}]);
});

test("partial evidence cannot be combined across alternative bundles",()=>{
  const expect={anyOf:[{textAll:["Title A","Control A"]},{textAll:["Title B","Control B"]}]};
  assert.equal(expectationMet(expect,view(2,["Title A","Control B"]),view(),profile),false);
  assert.equal(expectationMet(expect,view(2,["Title B","Control B"]),view(),profile),true);
});

test("title evidence uses logical screen geometry rather than matching a list row",()=>{
  const expect={textAt:[{text:"General",region:{left:.2,top:0,right:.8,bottom:.25}}]};
  const v=view(2,["General"]);
  assert.equal(expectationMet(expect,v,view(),profile),true);
  v.elements[0].center.y=900;
  assert.equal(expectationMet(expect,v,view(),profile),false);
  v.elements[0].center={x:10,y:10};
  assert.equal(expectationMet(expect,v,view(),profile),false);
});

test("unexpected dialogs cannot confirm a surviving background page",()=>{
  const v=view(2,["Done"]);v.state.overlay="dialog";
  assert.equal(expectationMet({textAll:["Done"]},v,view(),profile),false);
  assert.equal(expectationMet({anyOf:[{textAll:["Done"]}]},v,view(),profile),false);
  assert.equal(expectationMet({anyOf:[{textAll:["Done"],overlay:"dialog"}]},v,view(),profile),true);
});

test("movement requires unique text and calibrated displacement in the requested direction",()=>{
  const before=view(1,["General"]);before.elements[0].center.y=850;
  const after=view(2,["General"]);after.elements[0].center.y=600;
  const expect={movedText:{text:"General",direction:"up" as const,minimumScreenFraction:.08}};
  assert.equal(expectationMet(expect,after,before,profile),true);
  assert.equal(expectationMet({...expect,movedText:{...expect.movedText,direction:"down"}},after,before,profile),false);
  assert.equal(expectationMet(expect,view(2,["General","General"]),before,profile),false);
});

test("one identical evidence bundle must hold across two eligible post-action frames",async()=>{
  const f=setup({after:seq=>view(seq,[seq%2 ? "A" : "B"])});
  const r=await f.executor.run({intent:request.intent,expect:{anyOf:[{textAll:["A"]},{textAll:["B"]}]}},{execute:true,verificationMs:500});
  assert.equal(r.status,"unverified");assert.equal(f.actions(),1);
  assert.ok(r.verificationSamples.some(s=>s.assessment?.met));
});

test("complete alternative evidence succeeds twice despite missing optional hints",async()=>{
  const f=setup({after:seq=>view(seq,["World Clock","New York"])});
  const r=await f.executor.run({intent:request.intent,expect:{anyOf:[{textAll:["World Clock","New York"]}],supportingText:["Alarm"]}},{execute:true,verificationMs:900});
  assert.equal(r.status,"verified");assert.equal(f.actions(),1);
  assert.deepEqual(r.verification?.matchedAlternatives,[0]);
  assert.deepEqual(r.verification?.supportingText,[{text:"Alarm",present:false}]);
});
