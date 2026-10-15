import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {detectSearchBackdrop,currentSearchBackdrop,systemSearchEvidence,systemSearchResultsEvidence,systemSearchResultTarget} from "./search-dismissal";
import {autonomousDecisionSchema,decodePlannerDecision,decisionRequest,stepCapabilities,planningDocument,plannerWireSchemaFor} from "./autonomous-planner";
import {detectObservedRegions,currentObservedRegion,sameObservedRegion} from "./observed-regions";
import {AutonomousPhoneRunner} from "./autonomous-runner";
import {selectAction,LocalClosedLoopExecutor,type LocalView} from "./executor";
import {localHomeDecision} from "./navigation-grounding";
import type {ScreenHandCalibrationProfile} from "../calibration-profile";

const profile:ScreenHandCalibrationProfile={id:"test",deviceId:"arm",verified:true,verifiedAt:"2026-09-08",
  frame:{width:720,height:1280},screen:{width:720,height:1280},imagePoints:[{x:0,y:0},{x:720,y:0},{x:720,y:1280},{x:0,y:1280}],
  machinePoints:[{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}],safeMachineBounds:{minimumX:9,maximumX:71,minimumY:19,maximumY:161},
  tap:{hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}};
async function view(content="",seq=1):Promise<LocalView>{
  const bytes=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#101010"/>${content}</svg>`)).jpeg().toBuffer();
  const at=Date.now();
  const labels:Array<[string,number,number,number]>=[["Siri Suggestions",220,175,150],["Show More",530,175,90],["Settings",200,300,70],
    ["Weather",300,300,70],["Selfie",240,365,70],["Recents",240,435,80],["AutoFill",210,695,80],["Q Search",215,745,120],["space",350,980,80]];
  return {deviceId:"arm",frame:{...profile.frame,sequence:seq,capturedAt:at,image:"data:image/jpeg;base64,"+bytes.toString("base64")},
    state:{page:"unknown",source:"insufficient_evidence",overlay:"none",keyboard:true,candidates:[],evidence:[],stableFrames:1,method:"local-feature-rules+temporal",scoreIsProbability:false},
    elements:labels.map(([text,x,y,w],i)=>({id:String(i),text,role:"text",confidence:.99,center:{x,y},bounds:{left:x-w/2,top:y-8,width:w,height:16}})),
    timing:{fetchMs:1,observationMs:1,ocrMs:1,ocrCacheHit:false,ocrCapturedAt:at,ocrAgeMs:0,stateMs:0,totalMs:1,frameAgeMs:0}};
}
const decision=()=>autonomousDecisionSchema.parse({kind:"action",reason:"Dismiss the observed search backdrop",objectives:["返回主页"],achieved:[],finalEvidence:[],
  step:{operation:"dismiss_search",text:null,direction:null,shape:null,beforeTexts:["Siri Suggestions","Show More"],afterTexts:[],verification:"home",afterKeyboard:false,allowOverlay:false,completesObjective:0}});

test('a populated search exposes its independent top result, never its inline completion',async()=>{
  const v=await view();v.elements=[['Top Hit',175],['Contacts',305],['Suggestions',368],['Q Contacts - Open',745]].map(([text,y],i)=>({id:String(i),role:'text',text:String(text),confidence:1,center:{x:250,y:Number(y)},bounds:{left:200,top:Number(y)-10,width:100,height:20}}));
  assert.ok(systemSearchResultsEvidence(v));assert.equal(systemSearchResultTarget(v,'Contacts')?.id,'1');
  assert.equal(systemSearchResultTarget(v,'Q Contacts - Open'),null);
  const context={goal:'打开Contacts',view:v,objectives:[],history:[],capabilities:{tap:true,home:true,swipe:true,longPress:true,inputText:true}};
  assert.match(JSON.stringify(plannerWireSchemaFor(context)),/open_app/);
  assert.equal(selectAction({type:'open_app',text:'Contacts'},v,profile).type,'tap');
  assert.throws(()=>selectAction({type:'open_app',text:'Q Contacts - Open'},v,profile),/unique observed search result/);
  v.elements.splice(1,1);assert.equal(systemSearchResultTarget(v,'Contacts'),null);
  v.state.keyboard=false;assert.equal(systemSearchResultsEvidence(v),null);
});
test("search backdrop is a pixel-checked gap and the planner, rather than the Home reflex, selects it",async()=>{
  const v=await view();v.searchBackdrop=await detectSearchBackdrop(v);assert.ok(v.searchBackdrop);
  assert.ok(v.searchBackdrop.center.y>480&&v.searchBackdrop.center.y<650);
  assert.equal(localHomeDecision("返回主页",v,[]),null);
  const doc=planningDocument({goal:"返回主页",view:v,objectives:[],history:[],capabilities:{tap:true,home:true,swipe:true,longPress:true,inputText:false}});
  assert.equal("dismissal" in doc.screen,false);
  assert.doesNotMatch(JSON.stringify(doc),/data:image|imageHash/);
  const d=decision(),r=decisionRequest(d);assert.deepEqual(stepCapabilities(d),["tap"]);
  assert.deepEqual(r.expect,{launcher:true,overlay:"none",keyboard:false});
  const a=selectAction(r.intent,v,profile);assert.equal(a.type,"tap");if(a.type==="tap")assert.deepEqual(a.point,v.searchBackdrop.center);
});
test("backdrop detection rejects other pages, overlays, missing evidence and unlabeled imagery in the gap",async()=>{
  for(const mutate of [(v:LocalView)=>{v.state.keyboard=false;},(v:LocalView)=>{v.state.overlay="dialog";},(v:LocalView)=>{v.elements[0].text="App Library";}]){
    const v=await view();mutate(v);assert.equal(systemSearchEvidence(v),null);assert.equal(await detectSearchBackdrop(v),null);
  }
  const control=await view('<rect x="240" y="480" width="260" height="185" rx="12" fill="white"/>');
  assert.equal(await detectSearchBackdrop(control),null);
});
test("a backdrop cannot be replayed across frames, images or outside calibration",async()=>{
  const v=await view();v.searchBackdrop=await detectSearchBackdrop(v);assert.ok(currentSearchBackdrop(v));
  v.frame.sequence++;assert.throws(()=>currentSearchBackdrop(v),/current/);v.frame.sequence--;
  const other=await view('<circle cx="300" cy="200" r="20" fill="white"/>');v.frame.image=other.frame.image;
  assert.throws(()=>currentSearchBackdrop(v),/current/);
  const fresh=await view();fresh.searchBackdrop=await detectSearchBackdrop(fresh);
  assert.throws(()=>selectAction({type:"dismiss_search"},fresh,{...profile,imagePoints:profile.imagePoints.map(p=>({x:p.x+600,y:p.y})) as ScreenHandCalibrationProfile["imagePoints"]}),/outside/);
});
test("a keyboard disappearing alone never counts as successful return Home",async()=>{
  let seq=0,actions=0;
  const deps={deviceId:"arm",getCalibration:async()=>profile,getDevice:async()=>({id:"arm",connected:true,status:"running",screen:null,
    state:{grbl:{homed:true,state:"Idle"}},capabilities:{actions:{tap:{available:true}}}}),
    observe:async()=>{const v=await view("",++seq);if(actions)v.state.keyboard=false;return v;},
    act:async()=>{actions++;return {receipt:{id:"one",status:"completed" as const},elapsedMs:1,response:{}};}};
  const r=await new LocalClosedLoopExecutor(deps).run(decisionRequest(decision()),{execute:true,verificationMs:250});
  assert.equal(actions,1);assert.equal(r.status,"unverified");assert.equal(r.verification?.met,false);
});

const regionDecision=()=>decodePlannerDecision({kind:"action",reason:"Current region may establish the requested destination",objectives:["返回主页"],achieved:[],finalEvidence:[],
  step:{operation:"tap_region",regionId:"gap_0",beforeTexts:["Siri Suggestions","Show More"],verification:"home",afterTexts:[],afterKeyboard:false,completesObjective:0}});
test("generic region detection is independent of page names and never supplies a dismissal effect",async()=>{
  const first=await view(),other=await view();
  other.elements[0].text="Project Schedule";other.elements[1].text="Options";other.elements[7].text="Filter items";other.state.keyboard=false;
  first.regions=await detectObservedRegions(first);other.regions=await detectObservedRegions(other);
  assert.equal(first.regions.length,1);assert.deepEqual(first.regions[0].bounds,other.regions[0].bounds);
  const doc=planningDocument({goal:"返回主页",view:first,objectives:[],history:[],capabilities:{home:true,tap:true,swipe:true,longPress:true,inputText:false}});
  assert.deepEqual(Object.keys(doc.screen.regions[0]),["id","kind","box","overlapsText"]);
  assert.equal("dismissal" in doc.screen,false);
  assert.equal(selectAction(decisionRequest(regionDecision()).intent,first,profile).type,"tap");
  assert.throws(()=>currentObservedRegion(first,"invented"),/current/);
  first.frame.sequence++;assert.throws(()=>currentObservedRegion(first,"gap_0"),/current/);
  const control=await view('<rect x="240" y="480" width="260" height="185" rx="12" fill="white"/>');
  assert.equal((await detectObservedRegions(control)).length,0);
  other.state.overlay="dialog";assert.equal((await detectObservedRegions(other)).length,0);
});
test("current wire excludes failed Home and unavailable capabilities without prescribing a replacement",async()=>{
  const v=await view();v.regions=await detectObservedRegions(v);
  const context={goal:"返回主页",view:v,objectives:[],history:[],capabilities:{home:true,tap:true,swipe:true,longPress:false,inputText:false},
    recovery:{excludedActions:[{operation:{type:"navigate",key:"home"},step:1,reason:"No visual effect"}]}};
  const schema=JSON.stringify(plannerWireSchemaFor(context));
  assert.doesNotMatch(schema,/"enum":\["home"\]|"long_press_text"|"input_text"|"fill_field"|dismiss_search/);
  assert.match(schema,/"enum":\["tap_region"\]/);assert.match(schema,/"enum":\["gap_0"\]/);
  v.regions=[];assert.doesNotMatch(JSON.stringify(plannerWireSchemaFor(context)),/"enum":\["tap_region"\]/);
});
test("generic region binding rejects a different gap after inference",async()=>{
  const first=await view(),second=await view("",2);first.regions=await detectObservedRegions(first);second.regions=await detectObservedRegions(second);
  assert.equal(sameObservedRegion(first,second,"gap_0"),true);
  const row=second.elements[5];row.bounds.top+=60;row.center.y+=60;
  second.regions=await detectObservedRegions(second);assert.equal(sameObservedRegion(first,second,"gap_0"),false);
});
test("a different goal can open an observed app suggestion without first dismissing search",async()=>{
  const v=await view();
  const decision=decodePlannerDecision({kind:"action",reason:"Settings is visible",objectives:["打开设置"],achieved:[],finalEvidence:[],
    step:{operation:"open_app",text:"Settings",beforeTexts:["Siri Suggestions","Settings"],completesObjective:0}});
  assert.equal(selectAction(decisionRequest(decision).intent,v,profile).type,"tap");
  assert.throws(()=>selectAction({type:"open_app",text:"Missing App"},v,profile),/unique|visible|No /i);
});
test("a generic region that has no effect is sent once; the runner passes its exclusion to subsequent decisions",async()=>{
  let sequence=0,actions=0,calls=0;
  const deps={deviceId:"arm",getCalibration:async()=>profile,getDevice:async()=>({id:"arm",connected:true,status:"running",screen:null,
    state:{grbl:{homed:true,state:"Idle"}},capabilities:{actions:{tap:{available:true},swipe:{available:true}}}}),
    observe:async()=>{const v=await view("",++sequence);v.regions=await detectObservedRegions(v);return v;},
    act:async()=>{actions++;return {receipt:{id:"one",status:"completed" as const},elapsedMs:1,response:{}};}};
  const runner=new AutonomousPhoneRunner(deps,{preferModelNavigation:true,imageUploads:4,decide:async context=>{
    calls++;if(calls>1)assert.equal(context.recovery?.excludedActions[0].operation.regionId,"gap_0");return regionDecision();
  }});
  const report=await runner.run("返回主页",{execute:true,signal:AbortSignal.timeout(10000),verificationMs:250,maximumDecisions:5});
  assert.equal(actions,1);assert.equal(report.status,"blocked");assert.equal(report.imageUploads,4);assert.equal(report.completionEvidence,undefined);
});
