import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import type { AgentDevice } from "../general-agent-client";
import type { LocalView, ControlDependencies } from "./executor";
import { AutonomousPhoneRunner, confirmsTexts, sceneKey, samePageForRetry, type AutonomousReport } from "./autonomous-runner";
import { OpenRouterAutonomousPlanner, autonomousDecisionSchema, decodePlannerDecision, decisionRequest, explorationRequest, planningDocument, type AutonomousDecision, type PlanningContext } from "./autonomous-planner";
import type {FieldEntryReport} from "./field-entry";
import {requestSchema} from "./contract";

const profile: ScreenHandCalibrationProfile = {id: "test-profile", deviceId: "arm", verified: true, verifiedAt: "2026-09-07",
  frame: {width: 720, height: 1280}, screen: {width: 720, height: 1560}, imagePoints: [{x:100,y:100},{x:620,y:100},{x:620,y:1180},{x:100,y:1180}],
  machinePoints: [{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}], safeMachineBounds: {minimumX:9,maximumX:71,minimumY:19,maximumY:161},
  tap: {hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}};
function view(texts = ["Start", "Panel"], seq = 1, at = Date.now()): LocalView {
  return {deviceId: "arm", frame: {sequence:seq,capturedAt:at,width:720,height:1280,image:"data:image/jpeg;base64,NEVER_UPLOAD"},
    state: {page:"unknown",source:"insufficient_evidence",overlay:"none",keyboard:false,candidates:[],evidence:[],stableFrames:1,method:"local-feature-rules+temporal",scoreIsProbability:false},
    elements:texts.map((text,i)=>({id:String(i),role:"text",text,confidence:.99,center:{x:250+i*70,y:250},bounds:{left:230+i*70,top:240,width:40,height:20}})),
    timing:{fetchMs:1,observationMs:2,ocrMs:1,ocrCacheHit:false,ocrCapturedAt:at,ocrAgeMs:0,stateMs:0,totalMs:3,frameAgeMs:0}};
}
function action(text = "Start", beforeTexts = ["Start", "Panel"], afterTexts = ["Destination", "Ready"]): AutonomousDecision {
  return {kind:"action",reason:"Select visible navigation",objectives:[],achieved:[],finalEvidence:[],
    step:{operation:"tap_text",text,direction:null,shape:null,beforeTexts,afterTexts,afterKeyboard:null,completesObjective:null,allowOverlay:false}};
}
function complete(texts = ["Destination", "Ready"]): AutonomousDecision {
  return {kind:"complete",reason:"Actual destination observed",objectives:[],achieved:[{objective:0,evidenceTexts:texts}],step:null,finalEvidence:texts};
}
function fixture(decide: (c: PlanningContext, call: number) => AutonomousDecision | Promise<AutonomousDecision>, options: {
  outcomes?: string[][]; receiptFails?: boolean; mutate?: (v: LocalView, observation: number) => void; profile?: () => ScreenHandCalibrationProfile;
} = {}) {
  let actions = 0, observations = 0, calls = 0, texts = ["Start", "Panel"];
  const device: AgentDevice = {id:"arm",connected:true,status:"running",screen:null,state:{grbl:{homed:true,state:"Idle"}},
    capabilities:{actions:{tap:{available:true},long_press:{available:true},swipe:{available:true},input_text:{available:false}}}};
  const deps: ControlDependencies = {deviceId:"arm", getDevice:async()=>device, getCalibration:async()=>options.profile?.() ?? profile,
    observe:async()=>{await delay(2);const v = view(texts,++observations);options.mutate?.(v,observations);return v;},
    act:async()=>{actions++;if(options.receiptFails)throw new Error("Receipt timed out");texts=options.outcomes?.[actions-1] ?? ["Destination","Ready"];
      return {receipt:{id:`r${actions}`,status:"completed"},elapsedMs:1,response:{}};}};
  const runner = new AutonomousPhoneRunner(deps,{decide: async c => decide(c,++calls)});
  return {runner,deps,actions:()=>actions,calls:()=>calls};
}
const opts = () => ({execute:true,signal:AbortSignal.timeout(10000),verificationMs:700});

function positionCatalog(v:LocalView){
  for(const [i,e] of v.elements.entries()){
    e.center={x:i===1?540:330,y:i<2?190:360+(i-2)*120};
    e.bounds={left:e.center.x-30,top:e.center.y-8,width:60,height:16};
  }
}
test("one model translation feeds general local catalog navigation without per-scroll inference",async()=>{
  const f=fixture(()=>{
    const d=explore(["App Library","Alpha"]);d.objectives=["打开新应用"];d.navigationTarget="Novel App";d.step!.direction="up";return d;
  },{outcomes:[["App Library","Cancel","Novel App","Zeta"],["Novel App","New content"]],mutate:v=>{
    if(v.elements[0].text==="Start")v.elements=view(["App Library","Cancel","Alpha","Beta"]).elements;
    if(v.elements[0].text==="App Library")positionCatalog(v);
    else {v.elements[0].center.y=180;v.elements[1].center.y=430;}
  }});
  const r=await f.runner.run("打开新应用",opts());
  assert.equal(r.status,"observed_complete");assert.equal(f.calls(),1);assert.equal(f.actions(),2);
  assert.equal(r.navigationTarget,"Novel App");assert.equal(r.decisions[1].source,"local_navigation");
  assert.equal(r.completionEvidence?.level,"local_navigation");
});
test("catalog bottom detection hands control to replanning after two non-advancing swipes",async()=>{
  const f=fixture(c=>{
    assert.equal(c.recovery?.excludedActions[0].operation.type,"swipe");
    assert.match(c.recovery!.excludedActions[0].reason,/Catalog did not advance/);
    return {kind:"blocked",reason:"Catalog did not advance; no alternative entry is visible",objectives:[],achieved:[],step:null,finalEvidence:[]};
  },{mutate:(v,observation)=>{
    v.elements=view(["App Library","Cancel","Alpha","Beta","Gamma",`Noise${observation}`]).elements;positionCatalog(v);
    v.elements.at(-1)!.center={x:650,y:600};
  }});
  const r=await f.runner.run("open ZZZZ",opts());
  assert.equal(r.status,"blocked");assert.match(r.error!,/Catalog did not advance/);
  assert.equal(f.actions(),2);assert.equal(f.calls(),1);assert.equal(r.completionEvidence,undefined);
});
test("compound app discovery scrolls locally, returns the opened page to the planner, and cannot complete the remaining goal",async()=>{
  const f=fixture((context,call)=>{
    if(call===1){const d=explore(["App Library","Alpha"]);d.objectives=["Open Novel App then inspect its configuration"];d.navigationTarget="Novel App";return d;}
    assert.equal(context.view.elements[0].text,"Novel App");
    assert.equal(context.objectives[0].verified,undefined);
    return {kind:"blocked",reason:"Configuration has not been inspected",objectives:[],achieved:[],step:null,finalEvidence:[]};
  },{outcomes:[["App Library","Cancel","Gamma","Lambda"],["App Library","Cancel","Novel App","Zeta"],["Novel App","New content"]],mutate:v=>{
    if(v.elements[0].text==="Start")v.elements=view(["App Library","Cancel","Alpha","Beta"]).elements;
    if(v.elements[0].text==="App Library")positionCatalog(v);
    else {v.elements[0].center.y=180;v.elements[1].center.y=430;}
  }});
  const r=await f.runner.run("Open Novel App then inspect its configuration",opts());
  assert.equal(f.calls(),2);assert.equal(f.actions(),3);assert.equal(r.status,"blocked");
  assert.equal(r.navigationDiscovery?.status,"returned_to_planner");
  assert.equal(r.objectives[0].verified,undefined);
  assert.deepEqual(r.decisions.map(d=>d.source),["model","local_navigation","local_navigation","model"]);
});

test("visible field input is integrated and every physical key uses the durable action journal",async()=>{
  const f=fixture(()=>complete());let calls=0;
  const runner=new AutonomousPhoneRunner(f.deps,{decide:async c=>{
    if(++calls===1){assert.equal(c.capabilities.inputText,true);assert.equal(c.visibleTextEntry,true);
      const d=action();d.objectives=["Enter the value"];
      d.step={...d.step!,operation:"fill_field",field:"Start",text:"ab",inputPurpose:"query",afterTexts:[]};return d;}
    assert.equal(c.fieldEntries?.[0].status,"verified");return complete();
  }},async(deps,field,value,signal,progress)=>{
    const entry:FieldEntryReport={status:"running",field,value,elapsedMs:1,reads:[]};await progress?.(entry);
    for(let i=0;i<3;i++)await deps.act({type:"tap",point:{x:200,y:800},viewport:profile.screen,frameSequence:i+1},signal,`field-${i}`);
    entry.status="verified";await progress?.(entry);return entry;
  });
  const checkpoints:number[]=[];
  const r=await runner.run("Enter ab",{...opts(),visibleTextEntry:true,checkpoint:async r=>{checkpoints.push(r.submissions.length);}});
  assert.equal(r.status,"observed_complete");assert.equal(r.fieldEntries[0].status,"verified");assert.equal(r.submissions.length,3);
  assert.ok(r.submissions.every(s=>s.state==="completed"&&s.action.type==="tap"));assert.ok(checkpoints.includes(1));assert.ok(checkpoints.includes(2));
});

test("partial field entry stops planning and cannot be automatically retried",async()=>{
  const f=fixture(()=>complete());let calls=0;
  const runner=new AutonomousPhoneRunner(f.deps,{decide:async()=>{
    calls++;const d=action();d.objectives=["Create record"];d.resultKind="form_storage";
    d.step={...d.step!,operation:"fill_field",field:"Start",text:"ab",inputPurpose:"form",afterTexts:[]};return d;
  }},async(deps,field,value,signal)=>{
    await deps.act({type:"tap",point:{x:200,y:800},viewport:profile.screen,frameSequence:1},signal,"partial-field");
    return {status:"blocked",field,value,error:"Wrong prefix",elapsedMs:1,reads:[]};
  });
  const r=await runner.run("Create record ab",{...opts(),visibleTextEntry:true});
  assert.equal(calls,1);assert.equal(r.status,"blocked");assert.equal(r.submissions.length,1);assert.equal(r.completionEvidence,undefined);
});

test('query mismatch yields to a separately observed result without claiming input verification or typing again',async()=>{
  let resultVisible=false,calls=0,entries=0;
  const f=fixture(()=>complete(),{mutate:v=>{if(!resultVisible)return;v.state.keyboard=true;v.elements=[['Top Hit',175],['Contacts',305],['Suggestions',368],['Q Contacts - Open',745]].map(([text,y],i)=>({id:String(i),role:'text',text:String(text),confidence:1,center:{x:250,y:Number(y)},bounds:{left:200,top:Number(y)-10,width:100,height:20}}));}});
  const runner=new AutonomousPhoneRunner(f.deps,{decide:async c=>{
    if(++calls===1){const d=action();d.objectives=['Open Contacts'];d.step={...d.step!,operation:'fill_field',field:'Start',text:'Contacts',inputPurpose:'query',afterTexts:[]};return d;}
    assert.equal(c.fieldEntries?.[0].status,'result_available');assert.equal(c.fieldEntries?.[0].purpose,'query');assert.ok(c.history.some(h=>h.status==='result_available'));
    return {kind:'blocked',reason:'Fixture ends before navigation',objectives:[],achieved:[],step:null,finalEvidence:[]};
  }},async(_deps,field,value)=>{entries++;resultVisible=true;return {status:'blocked',field,value,error:'Expected Cont, observed Q Contacts - Open',elapsedMs:1,reads:[],typing:{status:'blocked',text:value,elapsedMs:1,keys:[]}};});
  const r=await runner.run('Open Contacts',{...opts(),visibleTextEntry:true});
  assert.equal(entries,1);assert.equal(calls,2);assert.equal(r.fieldEntries[0].status,'result_available');assert.equal(r.completionEvidence,undefined);assert.equal(f.actions(),0);
});

test("a model cannot call an on-screen form saved without commit and independent reopen evidence",async()=>{
  const f=fixture(()=>({...complete(["Start","Panel"]),resultKind:"form_storage",objectives:["Save record"]}));
  const r=await f.runner.run("Save record",{...opts(),visibleTextEntry:true});
  assert.equal(r.status,"blocked");assert.match(r.error!,/reopened/);assert.equal(f.actions(),0);assert.equal(r.completionEvidence,undefined);
});

test("next decision is based on the actual unexpected page, not the failed prediction", async()=>{
  const f=fixture((context,call)=>{
    if(call===1)return {...action(),objectives:["Reach the destination"]};
    if(call===2){assert.deepEqual(context.view.elements.map(e=>e.text),["Unexpected","Close"]);assert.equal(context.history.at(-1)?.status,"unverified");
      return action("Close",["Unexpected","Close"]);}
    return complete();
  },{outcomes:[["Unexpected","Close"],["Destination","Ready"]]});
  const report=await f.runner.run("Reach the destination",opts());
  assert.equal(report.status,"observed_complete");assert.equal(f.actions(),2);assert.equal(f.calls(),3);
  assert.deepEqual(report.steps.map(s=>s.status),["unverified","verified"]);
  assert.equal(report.terminalInterventions,0);assert.equal(report.completionEvidence?.deliveryOrStorageVerified,false);
});
test("finish cannot discard an uncompleted objective",async()=>{
  const f=fixture((_,call)=>call===1?{...action(),objectives:["Reach destination","Return afterward"]}:complete());
  const r=await f.runner.run("Reach destination then return",opts());
  assert.equal(r.status,"blocked");assert.match(r.error!,/every frozen objective/);assert.equal(f.actions(),1);
});
test("Luna preview's out-of-range objective proof cannot finish or move hardware",async()=>{
  const f=fixture(()=>({...complete(["Start","Panel"]),objectives:["Reach destination"],
    achieved:[{objective:1,evidenceTexts:["Start","Panel"]}]}));
  const r=await f.runner.run("Reach destination",opts());
  assert.equal(r.status,"blocked");assert.match(r.error!,/nonexistent objective/);assert.equal(f.calls(),3);
  assert.equal(f.actions(),0);assert.equal(r.completionEvidence,undefined);
});
test("predeclared outcome can finish locally after full independent postconditions, without another model call",async()=>{
  const f=fixture(()=>{const d=action();d.objectives=["Reach destination"];d.step!.completesObjective=0;return d;});
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"observed_complete");assert.equal(f.calls(),1);assert.equal(f.actions(),1);
  assert.deepEqual(r.objectives[0].verified?.texts,["Destination","Ready"]);
});
test("local outcome optimization cannot skip a goal or treat an incorrect prediction as success",async()=>{
  const f=fixture((_,call)=>{const d=action();d.objectives=call===1?["Reach destination"]:[];d.step!.completesObjective=0;return d;},{outcomes:[["Other","Actual"]]});
  const r=await f.runner.run("Reach destination",{...opts(),maximumDecisions:1});assert.equal(r.status,"budget_exhausted");assert.equal(r.objectives[0].verified,undefined);
  const g=fixture(()=>{const d=action();d.objectives=["First outcome","Second outcome"];d.step!.completesObjective=1;return d;});
  const second=await g.runner.run("First then second",opts());assert.equal(second.status,"blocked");assert.equal(g.actions(),0);assert.equal(g.calls(),3);
});
test("invalid action contract is fed back for bounded autonomous repair, not a guessed action",async()=>{
  const f=fixture((context,call)=>{
    if(call===1){const d=action();d.objectives=["Reach destination"];d.step!.direction="up";return d;}
    if(call===2){assert.equal(context.history.at(-1)?.status,"proposal_rejected");return action();}
    return complete();
  });
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"observed_complete");assert.equal(f.actions(),1);assert.equal(f.calls(),3);
});
test("objectives cannot be rewritten during a run",async()=>{
  const f=fixture((_,call)=>call===1?{...action(),objectives:["Reach destination"]}:{...complete(),objectives:["A different easier task"]});
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"failed");assert.match(r.error!,/rewrite/);
});
test("an identical objective echo preserves verified outcomes with no repair call",async()=>{
  const objectives=["First outcome","Second outcome"];
  const f=fixture((context,call)=>{
    const d=call===1?action("Start",["Start","Panel"],["First","Ready"]):action("Next",["First","Ready"],["Second","Finished"]);
    d.objectives=[...objectives];d.step!.completesObjective=call-1;
    if(call===2){assert.ok(context.objectives[0].verified);assert.equal(planningDocument(context).objectives[1].index,1);}
    return d;
  },{outcomes:[["First","Ready","Next"],["Second","Finished"]]});
  const r=await f.runner.run("First then second",opts());
  assert.equal(r.status,"observed_complete");assert.equal(f.calls(),2);assert.equal(f.actions(),2);
  assert.ok(r.objectives.every(o=>o.verified));assert.match(r.decisions[1].notes![0],/Identical/);
  assert.deepEqual(r.decisions[1].decision!.objectives,objectives);
});
test("bad objective indices return to the model without renumbering or a motor submission",async()=>{
  const f=fixture((context,call)=>{
    if(call===1)return {...complete(["Start","Panel"]),objectives:["Already on panel"],achieved:[{objective:1,evidenceTexts:["Start","Panel"]}]};
    assert.match(context.history.at(-1)!.error!,/zero-based/);
    return complete(["Start","Panel"]);
  });
  const r=await f.runner.run("Observe panel",opts());assert.equal(r.status,"observed_complete");assert.equal(f.calls(),2);assert.equal(f.actions(),0);
  assert.equal(r.decisions[0].decision!.achieved[0].objective,1);
});
test("an already-visible first outcome must gain actual evidence before linking a step to the next",async()=>{
  const f=fixture((context,call)=>{
    const d=action();d.step!.completesObjective=1;
    if(call===1)d.objectives=["Observe initial panel","Reach destination"];
    else {
      assert.match(context.history.at(-1)!.error!,/next unverified index is 0/);
      d.achieved=[{objective:0,evidenceTexts:["Start","Panel"]}];
    }
    return d;
  });
  const r=await f.runner.run("Observe panel then reach destination",opts());assert.equal(r.status,"observed_complete");assert.equal(f.calls(),2);assert.equal(f.actions(),1);
  assert.ok(r.objectives[0].verified);assert.equal(r.decisions[0].decision!.achieved.length,0);
});
function explore(beforeTexts=["Start","Panel"]):AutonomousDecision {
  const d=action();Object.assign(d.step!,{operation:"swipe",text:null,direction:"left",verification:"observe",beforeTexts,afterTexts:[],afterKeyboard:null});return d;
}
test("exploration returns actual new content to planning without claiming the goal is done",async()=>{
  const f=fixture((context,call)=>{
    if(call===1)return {...explore(),objectives:["Find a destination"]};
    assert.equal(context.history.at(-1)?.status,"observed");assert.deepEqual(context.view.elements.map(e=>e.text),["Unexpected","Next"]);
    assert.equal(context.objectives[0].verified,undefined);
    return {kind:"blocked",reason:"No destination yet",objectives:[],achieved:[],step:null,finalEvidence:[]};
  },{outcomes:[["Unexpected","Next"]]});
  const r=await f.runner.run("Find a destination",opts());assert.equal(r.steps[0].status,"observed");assert.equal(r.status,"blocked");assert.equal(f.actions(),1);assert.equal(r.completionEvidence,undefined);
});
test("exploration cannot replay unchanged content or certify completion with a weaker contract",async()=>{
  const f=fixture((_,call)=>({...explore(),objectives:call===1?["Find destination"]:[]}),{outcomes:[["Start","Panel"]]});
  const r=await f.runner.run("Find destination",opts());assert.equal(f.actions(),1);assert.match(r.error!,/Repeated action/);
  const d=explore();d.step!.completesObjective=0;assert.throws(()=>explorationRequest(d),/Exploration/);
  d.step!.completesObjective=null;d.step!.afterTexts=["Contacts","Phone"];assert.throws(()=>explorationRequest(d),/Exploration/);
  d.step!.afterTexts=[];d.step!.operation="tap_text";d.step!.text="Start";assert.throws(()=>explorationRequest(d),/Exploration/);
  assert.throws(()=>decisionRequest(explore()),/observation-only/);
  const destination=action();destination.step!.afterTexts=[];assert.throws(()=>decisionRequest(destination),/two positive/);
});
test("preview asks for one decision and never moves or claims completion",async()=>{
  const f=fixture(()=>({...action(),objectives:["Reach destination"]}));
  const r=await f.runner.run("Reach destination",{...opts(),execute:false});assert.equal(r.status,"preview");assert.equal(f.actions(),0);assert.equal(f.calls(),1);
});
test("uncertain receipt halts without another model call, tap or Home cleanup",async()=>{
  const f=fixture(()=>({...action(),objectives:["Reach destination"]}),{receiptFails:true});
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"action_uncertain");assert.equal(f.actions(),1);assert.equal(f.calls(),1);assert.equal(r.submissions[0].state,"uncertain");
});
test("dispatch intent is persisted before the hardware request",async()=>{
  const f=fixture((_,call)=>call===1?{...action(),objectives:["Reach destination"]}:complete());
  const copies: AutonomousReport[]=[];
  await f.runner.run("Reach destination",{...opts(),checkpoint:async r=>{if(r.submissions.at(-1)?.state==="dispatching")assert.equal(f.actions(),0);copies.push(structuredClone(r));}});
  assert.ok(copies.some(r=>r.submissions.at(-1)?.state==="dispatching"));assert.ok(copies.some(r=>r.submissions.at(-1)?.state==="completed"));
});
test("failed pre-dispatch journal never reaches hardware",async()=>{
  const f=fixture(()=>({...action(),objectives:["Reach destination"]}));
  const r=await f.runner.run("Reach destination",{...opts(),checkpoint:async r=>{if(r.phase!=="finished"&&r.submissions.at(-1)?.state==="dispatching")throw new Error("Disk full");}});
  assert.equal(r.status,"action_uncertain");assert.equal(f.actions(),0);
});
test("same action on unchanged content is not replayed under a new idempotency key",async()=>{
  const f=fixture((_,call)=>({...action(),objectives:call===1?["Reach destination"]:[]}),{outcomes:[["Start","Panel"]]});
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"blocked");assert.match(r.error!,/Repeated action/);assert.equal(f.actions(),1);
});
test("typing capability remains honestly unavailable without verified keyboard calibration",async()=>{
  const d=action();d.step!.operation="input_text";d.step!.text="hello";
  const f=fixture(c=>{assert.equal(c.capabilities.inputText,false);return {...d,objectives:["Enter hello"]};});
  const r=await f.runner.run("Enter hello",opts());assert.equal(r.status,"blocked");assert.equal(f.actions(),0);assert.match(r.error!,/Required capability unavailable: inputText/);
});
test("new record storage still blocks unavailable typing before navigating to an input form",async()=>{
  const f=fixture(()=>({...action(),resultKind:"form_storage",objectives:["Fill a field"],requiredCapabilities:["tap","inputText"]}));
  const r=await f.runner.run("Fill a field",opts());assert.equal(r.status,"blocked");assert.equal(f.actions(),0);
  assert.match(r.error!,/requires verified text entry/);assert.equal(r.capabilities?.inputText,false);
  assert.deepEqual(r.requiredCapabilities,["tap"]);assert.equal(f.calls(),1);
});
test("unused speculative input capability cannot block a valid navigation step",async()=>{
  const f=fixture((_,call)=>call===1?{...action(),objectives:["Open an app"],requiredCapabilities:["tap","inputText","longPress"]}:complete());
  const r=await f.runner.run("Open an app",opts());assert.equal(r.status,"observed_complete");assert.equal(f.actions(),1);
  assert.deepEqual(r.requiredCapabilities,["tap"]);assert.match(r.decisions[0].notes!.join(" "),/Advisory/);
});
test("omitted later capability requirements cannot erase earlier requirements",async()=>{
  const f=fixture((_,call)=>call===1?{...action(),objectives:["Reach destination"],requiredCapabilities:["tap"]}:complete());
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"observed_complete");assert.deepEqual(r.requiredCapabilities,["tap"]);
});
test("stale or cached decision revalidation cannot produce a click",async()=>{
  for(const mutate of [(v:LocalView,n:number)=>{if(n>=2)v.frame.capturedAt-=5000;},(v:LocalView,n:number)=>{if(n===2)v.timing.ocrCacheHit=true;}]){
    const f=fixture(()=>({...action(),objectives:["Reach destination"]}),{mutate});
    const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"failed");assert.equal(f.actions(),0);
  }
});
test("one stale OCR observation is replaced by a new read, never used for a motor command",async()=>{
  const f=fixture((_,call)=>call===1?{...action(),objectives:["Reach destination"]}:complete(),{mutate:(v,n)=>{if(n===1)v.frame.capturedAt-=5000;}});
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"observed_complete");assert.equal(r.staleObservationRetries,1);assert.equal(f.actions(),1);
  assert.ok(r.steps[0].action?.type==="tap"&&r.steps[0].action.frameSequence!>1);
});
test("changing calibration while thinking invalidates completion and movement",async()=>{
  let changed=false;const f=fixture(()=>{changed=true;return {...action(),objectives:["Reach destination"]};},{profile:()=>changed?{...profile,id:"moved"}:profile});
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"failed");assert.equal(f.actions(),0);assert.match(r.error!,/Calibration changed/);
});
test("a decision limit is a stop, not successful completion",async()=>{
  const f=fixture(()=>({...action(),objectives:["Reach destination"]}));
  const r=await f.runner.run("Reach destination",{...opts(),maximumDecisions:1});assert.equal(r.status,"budget_exhausted");assert.equal(f.actions(),1);
});
test("abort and invalid budgets cannot dispatch actions",async()=>{
  const f=fixture(()=>({...action(),objectives:["Reach destination"]}));
  const abort=new AbortController();abort.abort();assert.equal((await f.runner.run("Reach destination",{...opts(),signal:abort.signal})).status,"budget_exhausted");
  await assert.rejects(f.runner.run("Reach destination",{...opts(),maximumActions:NaN}),/budget/);assert.equal(f.actions(),0);
});
test("two frames and two distinct spatially corroborated high-confidence labels are required for evidence",()=>{
  const a=view(),b=view(undefined,2,a.frame.capturedAt+1);assert.equal(confirmsTexts(["Start","Panel"],a,b),true);
  assert.equal(confirmsTexts(["Start","Start"],a,b),false);assert.equal(confirmsTexts(["Start","Panel"],a,a),false);
  b.elements[1].confidence=.75;assert.equal(confirmsTexts(["Start","Panel"],a,b),false);
  b.elements[1].confidence=.99;b.state.overlay="dialog";assert.equal(confirmsTexts(["Start","Panel"],a,b),false);
});
test("repeated heading/tab text can prove presence without permitting an ambiguous click",()=>{
  const a=view(["Recents","Shared"],1),b=view(["Recents","Shared"],2,a.frame.capturedAt+1);
  a.elements.push({...a.elements[0],id:"tab",center:{x:250,y:1050}});
  assert.equal(confirmsTexts(["Recents","Shared"],a,b),true);
  b.elements[0].center.y=600;assert.equal(confirmsTexts(["Recents","Shared"],a,b),false);
});
test("clock/frame/receipt churn cannot bypass no-progress detection",()=>{
  const a=view(["3:15","Start","Panel"]),b=view(["3:16","Start","Panel"],2);
  for(const v of [a,b]){v.elements[0].center.y=50;v.elements[0].bounds.top=40;}
  assert.equal(sceneKey(a),sceneKey(b));b.elements[2].text="Destination";assert.notEqual(sceneKey(a),sceneKey(b));
});
test("retry veto tolerates keyboard OCR and one changed suggestion but respects spatial page changes",()=>{
  const a=view(["Siri Suggestions","Show More","Settings","Weather","Camera","App Store","Selfie","Recents","q"]);
  const b=structuredClone(a);a.state.keyboard=b.state.keyboard=true;
  for(const v of [a,b])for(const [i,e] of v.elements.entries()){
    e.center={x:200+(i%3)*120,y:200+Math.floor(i/3)*100};
    e.bounds={left:e.center.x-20,top:e.center.y-10,width:40,height:20};
  }
  b.elements[5].text="Photos";b.elements[8].text="OCR jitter";b.elements[8].bounds.top=850;
  assert.notEqual(sceneKey(a),sceneKey(b));assert.equal(samePageForRetry(a,b),true);
  const moved=structuredClone(b);for(const e of moved.elements)e.bounds.top+=100;
  assert.equal(samePageForRetry(a,moved),false);
  const destination=view(["Phone","Keypad","Contacts"]);destination.state.keyboard=true;
  assert.equal(samePageForRetry(a,destination),false);
  b.state.keyboard=false;assert.equal(samePageForRetry(a,b),false);
  assert.equal(samePageForRetry(view(),view()),false);
});
test("replanning cannot send a second ineffective Home despite changing keyboard OCR",async()=>{
  const f=fixture((_,call)=>{
    const d=action();d.objectives=call===1?["Open application","Enter a value"]:[];
    d.step={...d.step!,operation:"home",text:null,beforeTexts:["Siri Suggestions","Show More"],afterTexts:[],verification:"home",afterKeyboard:false};
    return d;
  },{profile:()=>({...profile,navigation:{home:{strategy:"screen-swipe",startPoint:{x:360,y:1530},endPoint:{x:360,y:1240},durationMs:250,source:"ios-face-id-home-v1"}}}),
    mutate:(v,n)=>{
      v.state.keyboard=true;
      v.elements=view(["Siri Suggestions","Show More","Settings","Weather","Camera",`Noise${n}`]).elements;
      for(const [i,e] of v.elements.entries()){
        e.center={x:220+(i%3)*100,y:i===5?950:220+Math.floor(i/3)*100};
        e.bounds={left:e.center.x-20,top:e.center.y-10,width:40,height:20};
      }
    }});
  const getDevice=f.deps.getDevice;
  f.deps.getDevice=async s=>{const d=await getDevice(s);return {...d,capabilities:{...d.capabilities,actions:{...d.capabilities.actions,phone_key:{available:true}}}};};
  const r=await f.runner.run("Open application then enter a value",{...opts(),verificationMs:100});
  assert.equal(r.status,"blocked");assert.match(r.error!,/three rejected proposals.*Repeated action.*OCR noise/);
  assert.equal(f.actions(),1);assert.equal(f.calls(),4);assert.equal(r.steps[0].status,"unverified");
  assert.equal(r.completionEvidence,undefined);
});
test("failed route is excluded immediately and an alternative completes the same objective",async()=>{
  const f=fixture((c,call)=>{
    if(call===1)return {...action(),objectives:["Reach destination"]};
    if(call===2){
      assert.equal(c.history.at(-1)?.status,"unverified");
      assert.deepEqual(c.recovery?.excludedActions.map(e=>e.operation.text),["Start"]);
      assert.equal(planningDocument(c).recovery.required,true);
      assert.equal(c.objectives[0].verified,undefined);
      return action("Panel");
    }
    assert.equal(c.recovery?.excludedActions.length,0);
    return complete();
  },{outcomes:[["Start","Panel"],["Destination","Ready"]]});
  const r=await f.runner.run("Reach destination",{...opts(),verificationMs:100});
  assert.equal(r.status,"observed_complete");assert.equal(f.actions(),2);assert.equal(f.calls(),3);
  assert.deepEqual(r.steps.map(s=>requestSchema.parse(s.request).intent),[{type:"tap_text",text:"Start",allowOverlay:false},{type:"tap_text",text:"Panel",allowOverlay:false}]);
});
test("a repeated proposal triggers read-only replanning and then a different action succeeds",async()=>{
  const f=fixture((c,call)=>{
    if(call===1)return {...action(),objectives:["Reach destination"]};
    if(call===2){const d=action("START");d.step!.allowOverlay=true;return d;}
    if(call===3){
      assert.equal(f.actions(),1);assert.equal(c.history.at(-1)?.status,"alternative_required");
      assert.equal(c.recovery?.excludedActions[0].step,1);
      return action("Panel");
    }
    return complete();
  },{outcomes:[["Start","Panel"],["Destination","Ready"]]});
  const r=await f.runner.run("Reach destination",{...opts(),verificationMs:100});
  assert.equal(r.status,"observed_complete");assert.equal(f.actions(),2);assert.equal(f.calls(),4);
  assert.match(r.decisions[1].error!,/Repeated action/);assert.equal(r.steps.length,2);
});
test("alternating failed routes stay excluded and cannot turn replanning into a motor loop",async()=>{
  const f=fixture((c,call)=>{
    if(call>=3)assert.deepEqual(c.recovery?.excludedActions.map(e=>e.operation.text),["Start","Panel"]);
    return {...action(call%2?"Start":"Panel"),objectives:call===1?["Reach destination"]:[]};
  },{outcomes:[["Start","Panel"],["Start","Panel"]]});
  const r=await f.runner.run("Reach destination",{...opts(),verificationMs:100});
  assert.equal(r.status,"blocked");assert.equal(f.actions(),2);assert.equal(f.calls(),5);
  assert.match(r.error!,/No new grounded route/);assert.equal(r.completionEvidence,undefined);
});
test("the same operation remains available on a genuinely different page",async()=>{
  const f=fixture((c,call)=>{
    if(call===1)return {...action(),objectives:["Reach destination"]};
    if(call===2){assert.equal(c.recovery?.excludedActions.length,0);return action("Start",["Start","Another Page"]);}
    return complete();
  },{outcomes:[["Start","Another Page"],["Destination","Ready"]]});
  const r=await f.runner.run("Reach destination",{...opts(),verificationMs:100});
  assert.equal(r.status,"observed_complete");assert.equal(f.actions(),2);
});
test("an unavailable proposed capability allows a different supported route",async()=>{
  const f=fixture((c,call)=>{
    if(call===1){const d=action();d.objectives=["Reach destination"];d.step!.operation="input_text";d.step!.text="Query";return d;}
    if(call===2){assert.equal(f.actions(),0);assert.equal(c.history.at(-1)?.status,"alternative_required");return action();}
    return complete();
  });
  const r=await f.runner.run("Reach destination",opts());
  assert.equal(r.status,"observed_complete");assert.equal(f.actions(),1);assert.equal(f.calls(),3);
});
test("a failed local Home yields to an alternative route and the launcher is independently verified",async()=>{
  const f=fixture(c=>{
    assert.equal(c.recovery?.excludedActions[0].operation.key,"home");
    return explore();
  },{outcomes:[["Start","Panel"],["LauncherMarker"]],
    profile:()=>({...profile,navigation:{home:{strategy:"screen-swipe",startPoint:{x:360,y:1530},endPoint:{x:360,y:1240},durationMs:250,source:"ios-face-id-home-v1"}}}),
    mutate:v=>{
      if(v.elements[0].text!=="LauncherMarker")return;
      v.elements=Array.from({length:12},(_,i)=>{
        const x=160+(i%4)*120,y=400+Math.floor(i/4)*170;
        return {id:String(i),text:`Application ${i}`,role:"text" as const,confidence:.99,center:{x,y},bounds:{left:x-30,top:y-8,width:60,height:16}};
      });
      v.elements.push({id:"search",text:"Q Search",role:"text",confidence:.99,center:{x:360,y:990},bounds:{left:330,top:982,width:60,height:16}});
    }});
  const getDevice=f.deps.getDevice;
  f.deps.getDevice=async s=>{const d=await getDevice(s);return {...d,capabilities:{...d.capabilities,actions:{...d.capabilities.actions,phone_key:{available:true}}}};};
  const r=await f.runner.run("返回主页",{...opts(),verificationMs:100});
  assert.equal(r.status,"observed_complete");assert.equal(f.actions(),2);assert.equal(f.calls(),1);
  assert.deepEqual(r.decisions.map(d=>d.source),["local_navigation","model","local_navigation"]);
  assert.equal(r.decisions[1].recovery?.excludedActions[0].step,1);
  assert.equal(r.completionEvidence?.level,"local_navigation");
});
test("missing launcher icon keeps compound app discovery active and navigates to the catalog",async()=>{
  const f=fixture((_,call)=>{
    assert.equal(call,1);
    const d=action();d.objectives=["Open Novel App","Inspect its configuration"];d.navigationTarget="Novel App";
    d.step={...d.step!,operation:"open_app",text:"Novel App",beforeTexts:["Application 0","Application 1"],afterTexts:[],verification:"app_title"};return d;
  },{mutate:v=>{
    v.elements=Array.from({length:12},(_,i)=>{
      const x=160+(i%4)*120,y=400+Math.floor(i/4)*170;
      return {id:String(i),text:`Application ${i}`,role:"text" as const,confidence:.99,center:{x,y},bounds:{left:x-30,top:y-8,width:60,height:16}};
    });
    v.elements.push({id:"search",text:"Q Search",role:"text",confidence:.99,center:{x:360,y:990},bounds:{left:330,top:982,width:60,height:16}});
  }});
  const r=await f.runner.run("Open Novel App then inspect its configuration",{...opts(),maximumDecisions:2,verificationMs:100});
  assert.equal(r.steps[0].status,"blocked");assert.equal(r.steps[0].actionSubmissionCount,0);
  assert.equal(r.decisions[1].source,"local_navigation");
  assert.equal(r.decisions[1].decision?.step?.direction,"left");
  assert.equal(f.calls(),1);assert.equal(f.actions(),1);assert.equal(r.objectives[0].verified,undefined);
});
test("generic layout hints separate prominent text and upper-left text without asserting a page or control",()=>{
  const v=view(["Parent","Current title","Row one","Row two","Row three"]);
  Object.assign(v.elements[0],{center:{x:180,y:170},bounds:{left:140,top:160,width:80,height:20}});
  Object.assign(v.elements[1],{center:{x:360,y:340},bounds:{left:285,top:325,width:150,height:30}});
  for(let i=2;i<v.elements.length;i++)Object.assign(v.elements[i],{center:{x:320,y:550+i*60},bounds:{left:260,top:540+i*60,width:120,height:20}});
  const c:PlanningContext={goal:"Inspect current page",view:v,objectives:[],history:[],capabilities:{home:true,inputText:false,longPress:true,swipe:true,tap:true}};
  const screen=planningDocument(c).screen,hints=screen.layoutHints;
  assert.equal(hints.hypothesesNotVerifiedControls,true);
  assert.deepEqual(hints.prominentTextIds.map(id=>screen.nodes.find(n=>n.id===id)!.text),["Current title"]);
  assert.deepEqual(hints.upperLeftTextIds.map(id=>screen.nodes.find(n=>n.id===id)!.text),["Parent"]);
  assert.equal("page" in hints,false);assert.equal("clickable" in hints,false);
});
test("generic operations decode and malformed or unlabeled primary actions reject",()=>{
  for(const operation of ["home","back","long_press_text","swipe"] as const){
    const d=action();d.step!.operation=operation;d.step!.text=operation==="long_press_text"?"Start":null;d.step!.direction=operation==="swipe"?"up":null;
    assert.ok(decisionRequest(d));
  }
  const d=action();d.step!.operation="tap_visual";d.step!.text=null;d.step!.shape="filled_circle";assert.throws(()=>decisionRequest(d),/result-verification/);
  const bad=action();bad.step!.direction="down";assert.throws(()=>decisionRequest(bad),/Unexpected/);
  assert.equal(autonomousDecisionSchema.safeParse({...action(),coordinates:{x:1,y:2}}).success,false);
});
test("provider receives only bounded text evidence, not screenshots or arbitrary snapshot properties",async()=>{
  const context:PlanningContext={goal:"Reach destination",view:view(),objectives:[],history:[],capabilities:{home:false,inputText:false,longPress:true,swipe:true,tap:true}};
  const outgoing=JSON.stringify(planningDocument(context));assert.ok(!outgoing.includes("NEVER_UPLOAD"));assert.ok(!outgoing.includes("data:image"));
  const planner=new OpenRouterAutonomousPlanner({apiKey:"private-test-secret",fetcher:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.ok(!JSON.stringify(body).includes("NEVER_UPLOAD"));assert.equal(body.provider.zdr,true);
    assert.equal(body.model,"openai/gpt-5.6-luna");assert.equal(body.max_completion_tokens,1800);assert.equal(body.max_tokens,undefined);
    assert.deepEqual(body.reasoning,{effort:"low",exclude:true});
    assert.deepEqual(body.provider,{only:["azure"],ignore:["azure/us","azure/eu"],allow_fallbacks:false,require_parameters:true,data_collection:"deny",zdr:true});
    assert.equal(body.response_format.type,"json_schema");assert.equal(body.response_format.json_schema.strict,true);
    const schema=body.response_format.json_schema.schema;
    assert.ok(schema.required.includes("requiredCapabilities"));
    assert.doesNotMatch(JSON.stringify(schema.properties.step),/open_catalog/);
    return Response.json({model:"openai/gpt-5.6-luna",provider:"Azure",choices:[{finish_reason:"stop",message:{content:JSON.stringify({...action(),objectives:["Reach destination"]})}}]});}});
  assert.equal((await planner.decide(context,AbortSignal.timeout(1000))).kind,"action");
  assert.deepEqual(planner.configuration,{model:"openai/gpt-5.6-luna",provider:"azure",reasoningEffort:"low",timeoutMs:5000});
  assert.deepEqual(planner.lastResponse,{model:"openai/gpt-5.6-luna",provider:"Azure"});
});
test("provider errors never echo private error bodies and incomplete JSON cannot authorize actions",async()=>{
  const context:PlanningContext={goal:"Reach destination",view:view(),objectives:[],history:[],capabilities:{home:false,inputText:false,longPress:true,swipe:true,tap:true}};
  for(const response of [new Response("private-test-secret",{status:400}),Response.json({model:"openai/gpt-5.6-luna",provider:"Azure",choices:[{finish_reason:"length",message:{content:"partial"}}]})]){
    const planner=new OpenRouterAutonomousPlanner({apiKey:"private-test-secret",fetcher:async()=>response});
    await assert.rejects(planner.decide(context,AbortSignal.timeout(1000)),e=>e instanceof Error&&!e.message.includes("private-test-secret"));
  }
});
test("Flash uses low thinking and the explicit Google route",async()=>{
  const context:PlanningContext={goal:"Reach destination",view:view(),objectives:[],history:[],capabilities:{home:false,inputText:false,longPress:true,swipe:true,tap:true}};
  const planner=new OpenRouterAutonomousPlanner({apiKey:"private-test-secret",model:"google/gemini-3.8-flash",fetcher:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.model,"google/gemini-3.8-flash");assert.equal(body.max_tokens,1800);
    assert.equal(body.max_completion_tokens,undefined);assert.deepEqual(body.reasoning,{effort:"low",exclude:true});
    assert.deepEqual(body.provider,{only:["google-vertex/global"],ignore:["google-vertex/global/flex","google-vertex/global/priority"],allow_fallbacks:false,require_parameters:true,data_collection:"deny",zdr:true});
    return Response.json({model:body.model,provider:"Google",choices:[{finish_reason:"stop",message:{content:JSON.stringify(action())}}]});}});
  assert.equal((await planner.decide(context,AbortSignal.timeout(1000))).kind,"action");
});
test("a claimed action without a step and a completion carrying an action are rejected",()=>{
  assert.throws(()=>decodePlannerDecision({...action(),step:null}),/non-null step/);
  assert.throws(()=>decodePlannerDecision({...action(),kind:"complete"}),/non-null step/);
  assert.equal(decodePlannerDecision(complete()).kind,"complete");
});
test("Luna cannot silently accept a different model/provider or an in-body provider error",async()=>{
  const context:PlanningContext={goal:"Reach destination",view:view(),objectives:[],history:[],capabilities:{home:false,inputText:false,longPress:true,swipe:true,tap:true}};
  const valid={model:"openai/gpt-5.6-luna",provider:"Azure",choices:[{finish_reason:"stop",message:{content:JSON.stringify(action())}}]};
  for(const [payload,expected] of [
    [{...valid,model:"google/gemini-3.8-flash"},/route mismatch/],
    [{...valid,provider:"OpenAI"},/route mismatch/],
    [{error:{code:502,message:"private-test-secret"}},/upstream error/],
  ] as const){
    let calls=0;
    const planner=new OpenRouterAutonomousPlanner({apiKey:"private-test-secret",fetcher:async()=>Response.json(++calls===1?valid:payload)});
    await planner.decide(context,AbortSignal.timeout(1000));assert.ok(planner.lastResponse);
    await assert.rejects(planner.decide(context,AbortSignal.timeout(1000)),expected);
    assert.equal(planner.lastResponse,undefined);assert.equal(calls,2);
  }
});
test("Flash-Lite uses minimal thinking, the explicit Google route, and text-only evidence",async()=>{
  const context:PlanningContext={goal:"Reach destination",view:view(),objectives:[],history:[],capabilities:{home:false,inputText:false,longPress:true,swipe:true,tap:true}};
  const planner=new OpenRouterAutonomousPlanner({apiKey:"private-test-secret",model:"google/gemini-3.5-flash-lite",fetcher:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.doesNotMatch(JSON.stringify(body),/NEVER_UPLOAD|data:image|image_url/);
    assert.deepEqual(body.reasoning,{effort:"minimal",exclude:true});assert.equal(body.max_tokens,1800);
    assert.deepEqual(body.provider,{only:["google-vertex/global"],ignore:["google-vertex/global/flex","google-vertex/global/priority"],allow_fallbacks:false,require_parameters:true,data_collection:"deny",zdr:true});
    return Response.json({model:body.model,provider:"Google",choices:[{finish_reason:"stop",message:{content:JSON.stringify(action())}}]});
  }});
  assert.equal((await planner.decide(context,AbortSignal.timeout(1000))).kind,"action");
  assert.equal(planner.imageUploads,0);assert.equal(planner.configuration.reasoningEffort,"minimal");
  assert.deepEqual(planner.lastResponse,{model:"google/gemini-3.5-flash-lite",provider:"Google"});
});
test("rate limits preserve a safe status, never provider text or an automatic image fallback",async()=>{
  const context:PlanningContext={goal:"Reach destination",view:view(),objectives:[],history:[],capabilities:{home:false,inputText:false,longPress:true,swipe:true,tap:true}};
  let calls=0;
  const planner=new OpenRouterAutonomousPlanner({apiKey:"private-test-secret",fetcher:async()=>{calls++;return Response.json({error:{code:429,message:"private-test-secret"}});}});
  await assert.rejects(planner.decide(context,AbortSignal.timeout(1000)),e=>e instanceof Error&&/429: rate limited/.test(e.message)&&!e.message.includes("private-test-secret"));
  assert.equal(calls,1);assert.equal(planner.imageUploads,0);assert.equal(planner.lastResponse,undefined);
});
test("a model timeout does not retry or switch providers",async()=>{
  const context:PlanningContext={goal:"Reach destination",view:view(),objectives:[],history:[],capabilities:{home:false,inputText:false,longPress:true,swipe:true,tap:true}};
  let calls=0;
  const planner=new OpenRouterAutonomousPlanner({apiKey:"private-test-secret",timeoutMs:100,fetcher:async(_url,init)=>{
    calls++;await delay(1000,undefined,{signal:init?.signal??undefined});throw new Error("Request should abort");}});
  await assert.rejects(planner.decide(context,AbortSignal.timeout(2000)),/aborted/i);
  assert.equal(calls,1);assert.equal(planner.lastResponse,undefined);
});
test("the host retries one timed-out inference on a new frame, preserving first-valid goal initialization",async()=>{
  let firstSequence=0;
  const f=fixture((context,call)=>{
    if(call===1){firstSequence=context.view.frame.sequence;throw new DOMException("Request timed out","TimeoutError");}
    assert.ok(context.view.frame.sequence>firstSequence);
    assert.equal(context.history.at(-1)?.status,"planning_retry");
    const d=action();d.objectives=["Reach destination"];d.step!.completesObjective=0;return d;
  });
  const r=await f.runner.run("Reach destination",opts());assert.equal(r.status,"observed_complete");
  assert.equal(r.modelCalls,2);assert.equal(r.planningTimeoutRetries,1);assert.equal(f.actions(),1);assert.ok(r.decisions[0].error);
});
test("inference retry preserves already-verified objectives and cannot exceed one retry or the call budget",async()=>{
  const f=fixture((context,call)=>{
    if(call===1){const d=action("Start",["Start","Panel"],["First","Ready"]);d.objectives=["First outcome","Second outcome"];d.step!.completesObjective=0;return d;}
    assert.ok(context.objectives[0].verified);
    if(call===2)throw new DOMException("Timed out","TimeoutError");
    const d=action("Next",["First","Ready"],["Second","Finished"]);d.step!.completesObjective=1;return d;
  },{outcomes:[["First","Ready","Next"],["Second","Finished"]]});
  const r=await f.runner.run("First then second",opts());assert.equal(r.status,"observed_complete");assert.equal(f.actions(),2);assert.equal(r.modelCalls,3);
  for(const maximumDecisions of [1,8]){
    const g=fixture(()=>{throw new DOMException("Timed out","TimeoutError");});
    const stopped=await g.runner.run("Go",{...opts(),maximumDecisions});assert.equal(stopped.status,"failed");assert.equal(g.calls(),maximumDecisions===1?1:2);assert.equal(g.actions(),0);
  }
});
test("preview, provider HTTP errors and an externally cancelled run never trigger inference retries",async()=>{
  const a=fixture(()=>{throw new DOMException("Timed out","TimeoutError");});
  assert.equal((await a.runner.run("Go",{...opts(),execute:false})).planningTimeoutRetries,0);assert.equal(a.calls(),1);
  const b=fixture(()=>{throw new Error("Autonomous planner HTTP 400");});
  assert.equal((await b.runner.run("Go",opts())).planningTimeoutRetries,0);assert.equal(b.calls(),1);
  const controller=new AbortController();
  const c=fixture(()=>{controller.abort();throw new DOMException("Stopped","AbortError");});
  const r=await c.runner.run("Go",{...opts(),signal:controller.signal});assert.equal(r.status,"budget_exhausted");assert.equal(r.planningTimeoutRetries,0);assert.equal(c.calls(),1);assert.equal(c.actions(),0);
});

test('stateful controls execute once each and completion reads the separate output twice',async()=>{
  let number='0',actions=0,sequence=0,call=0;
  const texts=()=>[number,'AC','8','+','6','='];
  const observe=async()=>{await delay(2);const v=view(texts(),++sequence);v.elements.forEach((e,i)=>{e.center={x:i===0?520:180+i*55,y:i===0?350:750};e.bounds={left:e.center.x-15,top:e.center.y-15,width:30,height:30};});return v;};
  const device:AgentDevice={id:'arm',connected:true,status:'running',screen:null,state:{grbl:{homed:true,state:'Idle'}},capabilities:{actions:{tap:{available:true}}}};
  const runner=new AutonomousPhoneRunner({deviceId:'arm',observe,getDevice:async()=>device,getCalibration:async()=>profile,act:async()=>{number=['8','8','8+6','14'][actions++];return {receipt:{id:`r${actions}`,status:'completed'},elapsedMs:1,response:{}};}},{decide:async c=>{
    const index=call++,label=['8','+','6','='][index];assert.ok(index<4);
    if(index)assert.equal(c.history.at(-1)?.actionSubmitted,true);
    const node=planningDocument(c).screen.nodes.find(n=>n.text===label&&n.box[1]>.5*1000)!;
    return decodePlannerDecision({kind:'action',reason:'Use current control and read output',objectives:index?[]:['Compute and read output'],achieved:[],finalEvidence:[],step:{operation:'tap_node',targetId:node.id,beforeTexts:['AC','='],result:index===1?null:{region:{left:.6,top:.2,right:.85,bottom:.4},text:['8','8','8+6','14'][index]},completesObjective:index===3?0:null}});
  }});
  const result=await runner.run('Compute and read output',opts());
  assert.equal(result.status,'observed_complete',result.error);assert.equal(actions,4);assert.equal(call,4);assert.deepEqual(result.completionEvidence?.texts,['14']);
  const last=result.steps.at(-1)!;assert.equal(last.status,'verified');assert.equal(last.verificationSamples.filter(s=>s.assessment?.met).length,2);
});

test('a repeated action request cannot complete by citing the old visible answer',async()=>{
  const f=fixture(()=>({kind:'complete',reason:'Old answer visible',objectives:['Repeat requested operation'],achieved:[{objective:0,evidenceTexts:['Start','Panel']}],step:null,finalEvidence:['Start','Panel']}));
  const r=await f.runner.run('重新执行操作',opts());assert.equal(r.status,'blocked');assert.match(r.error??'',/fresh action/);assert.equal(f.actions(),0);assert.equal(f.calls(),3);
});
test('static result evidence reports zero submissions and duplicate contracts do not execute',async()=>{
  let sawFeedback=false;const f=fixture((c,call)=>{if(call>1){sawFeedback=c.history.some(h=>h.actionSubmitted===false&&h.error?.includes('BEFORE'));}return {...action('Start',['Start','Panel'],['Start','Panel']),objectives:call===1?['Change the displayed result']:[]};});
  const r=await f.runner.run('Change the displayed result',opts());assert.equal(f.actions(),0);assert.equal(r.status,'blocked');assert.equal(sawFeedback,true);assert.equal(r.steps.length,1);
});

test('message submission verifies a new outgoing bubble once and never calls it delivery',async()=>{
  let sent=false,actions=0,seq=0,calls=0;
  const observe=async()=>{await delay(2);const v=view(['10086','hi','Send'],++seq);v.elements.forEach((e,i)=>{e.center={x:i===2?540:400,y:i===0?200:i===1?(sent?400:680):680};e.bounds={left:e.center.x-15,top:e.center.y-15,width:30,height:30};});return v;};
  const device:AgentDevice={id:'arm',connected:true,status:'running',screen:null,state:{grbl:{homed:true,state:'Idle'}},capabilities:{actions:{tap:{available:true}}}};
  const runner=new AutonomousPhoneRunner({deviceId:'arm',observe,getDevice:async()=>device,getCalibration:async()=>profile,act:async()=>{sent=true;actions++;return {receipt:{id:'sent',status:'completed'},elapsedMs:1,response:{}};}},{decide:async c=>{calls++;return decodePlannerDecision({kind:'action',reason:'Submit exact prepared message once',objectives:['Send hi to 10086'],achieved:[],finalEvidence:[],step:{operation:'send_message',targetId:planningDocument(c).screen.nodes.find(n=>n.text==='Send')!.id,recipient:'10086',body:'hi',recipientRegion:{left:.1,top:.1,right:.8,bottom:.2},composerRegion:{left:.1,top:.5,right:.7,bottom:.6},outgoingRegion:{left:.1,top:.25,right:.8,bottom:.4},beforeTexts:['10086','hi'],completesObjective:0}});}});
  const r=await runner.run('给10086发hi',opts());assert.equal(r.status,'observed_complete',r.error);assert.equal(actions,1);assert.equal(calls,1);assert.equal(r.message?.status,'outgoing_visible');assert.equal(r.message?.deliveryVerified,false);assert.equal(r.completionEvidence?.deliveryOrStorageVerified,false);
});

test('an uncertain or visibly unchanged message submission stops without a second send',async()=>{
  for(const uncertain of [false,true]){
    let actions=0,seq=0,calls=0;
    const observe=async()=>{await delay(2);const v=view(['10086','hi','Send'],++seq);v.elements.forEach((e,i)=>{e.center={x:i===2?540:400,y:i===0?200:680};e.bounds={left:e.center.x-15,top:e.center.y-15,width:30,height:30};});return v;};
    const device:AgentDevice={id:'arm',connected:true,status:'running',screen:null,state:{grbl:{homed:true,state:'Idle'}},capabilities:{actions:{tap:{available:true}}}};
    const runner=new AutonomousPhoneRunner({deviceId:'arm',observe,getDevice:async()=>device,getCalibration:async()=>profile,act:async()=>{actions++;if(uncertain)throw new Error('receipt connection lost');return {receipt:{id:'sent',status:'completed'},elapsedMs:1,response:{}};}},{decide:async c=>{calls++;return decodePlannerDecision({kind:'action',reason:'Submit prepared message',objectives:['Send hi to 10086'],achieved:[],finalEvidence:[],step:{operation:'send_message',targetId:planningDocument(c).screen.nodes.find(n=>n.text==='Send')!.id,recipient:'10086',body:'hi',recipientRegion:{left:.1,top:.1,right:.8,bottom:.2},composerRegion:{left:.1,top:.5,right:.7,bottom:.6},outgoingRegion:{left:.1,top:.25,right:.8,bottom:.4},beforeTexts:['10086','hi'],completesObjective:0}});}});
    const r=await runner.run('给10086发hi',opts());assert.equal(actions,1);assert.equal(calls,1);assert.equal(r.message?.submitted,true);assert.equal(r.message?.status,uncertain?'uncertain':'unverified');assert.notEqual(r.status,'observed_complete');
  }
});
