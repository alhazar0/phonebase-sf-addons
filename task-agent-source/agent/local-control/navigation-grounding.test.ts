import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {navigationLayout,appTitleEvidence,localHomeDecision,localAppDecision,catalogEntries,launcherIconTarget,catalogIconTarget} from "./navigation-grounding";
import {decisionRequest,stepCapabilities} from "./autonomous-planner";
import {selectAction,cameraToScreen,type LocalView} from "./executor";
import type {ScreenHandCalibrationProfile} from "../calibration-profile";
import {canonicalLabel} from "./text-label";
const profile:ScreenHandCalibrationProfile={id:"fixture",deviceId:"arm",verified:true,verifiedAt:"test",frame:{width:720,height:1280},screen:{width:720,height:1560},imagePoints:[{x:100,y:100},{x:620,y:100},{x:620,y:1180},{x:100,y:1180}],machinePoints:[{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}],safeMachineBounds:{minimumX:9,maximumX:71,minimumY:19,maximumY:161},tap:{hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}};
function view(nodes:Array<[string,number,number]>,width=720,height=1280):LocalView {
  const at=Date.now();return {deviceId:"arm",frame:{sequence:1,capturedAt:at,width,height,image:""},state:{page:"unknown",source:"insufficient_evidence",overlay:"none",keyboard:false,candidates:[],evidence:[],stableFrames:1,method:"local-feature-rules+temporal",scoreIsProbability:false},elements:nodes.map(([text,x,y],i)=>({id:String(i),role:"text",text,confidence:.99,center:{x,y},bounds:{left:x-30,top:y-8,width:60,height:16}})),timing:{fetchMs:1,observationMs:2,ocrMs:1,ocrCacheHit:false,ocrCapturedAt:at,ocrAgeMs:0,stateMs:0,totalMs:3,frameAgeMs:0}};
}
const catalog=()=>view([["Q App Library",360,200],["Group A",250,355],["Group B",470,355],["Group C",250,597],["Group D",470,597],["Group E",250,832],["Group F",470,832]]);
const home=()=>view([...Array.from({length:12},(_,i)=>[`Application ${i}`,160+(i%4)*120,400+Math.floor(i/4)*170] as [string,number,number]),["Q Search",360,990]]);
test("catalog group captions never dispatch taps but the observed search field can",()=>{
  const v=catalog();assert.equal(navigationLayout(v).categoryGrid,true);
  assert.throws(()=>selectAction({type:"tap_text",text:"Group A"},v,profile),/category caption/);
  assert.equal(selectAction({type:"tap_text",text:"Q App Library"},v,profile).type,"tap");
  assert.throws(()=>selectAction({type:"open_app",text:"Group A"},v,profile),/category caption/);
});
test("experimental app icons require current pixels, sequence and calibration and do not forge OCR labels",()=>{
  const v=catalog();v.frame.image="data:image/jpeg;base64,dGVzdA==";
  v.appIcons=[{label:"Unseen App",source:"local_template",score:.99,runnerUpScore:.2,ambiguous:false,
    bounds:{left:200,top:400,width:60,height:60},center:{x:230,y:430},frameSequence:v.frame.sequence,
    frameSha256:createHash("sha256").update(Buffer.from("test")).digest("hex"),calibrationFingerprint:createHash("sha256").update(JSON.stringify(profile)).digest("hex")}];
  const d=localAppDecision("打开 Unseen App",v,[])!;
  assert.equal(d.step?.operation,"open_app");assert.equal(v.elements.some(e=>e.text==="Unseen App"),false);
  assert.equal(selectAction({type:"open_app",text:"Unseen App"},v,profile).type,"tap");
  v.appIcons[0].frameSequence++;assert.throws(()=>selectAction({type:"open_app",text:"Unseen App"},v,profile),/found 0/);
  v.appIcons[0].frameSequence=v.frame.sequence;v.appIcons[0].calibrationFingerprint="b".repeat(64);
  assert.throws(()=>selectAction({type:"open_app",text:"Unseen App"},v,profile),/found 0/);
});
test("a labeled catalog can open any observed app without an input capability or app dictionary",()=>{
  const v=view([["App Library",350,180],["Arbitrary New App",330,400],["Another",300,550]]);v.state.keyboard=true;
  assert.equal(navigationLayout(v).categoryGrid,false);
  assert.equal(selectAction({type:"open_app",text:"Arbitrary New App"},v,profile).type,"tap");
});
test("Home reflex needs spatial launcher evidence and must not capture compound tasks",()=>{
  assert.equal(navigationLayout(home()).home,true);assert.equal(navigationLayout(catalog()).home,false);
  const d=localHomeDecision("返回主页",home(),[])!;assert.equal(d.kind,"complete");
  assert.equal(localHomeDecision("返回主页然后打开某个应用",home(),[]),null);
  const other=view([["Photos",250,170],["6 Photos",250,210]]);
  const action=localHomeDecision("返回主页",other,[])!;assert.equal(action.kind,"action");assert.deepEqual(stepCapabilities(action),["home"]);
  assert.deepEqual(decisionRequest(action).expect,{launcher:true,overlay:"none",keyboard:false});
});
test("app verification uses actual title and new content, not Library/Albums guesses",()=>{
  const before=home(),after=view([["Application 3",230,170],["6 Items",230,230],["Recent Days",230,800]]);
  assert.deepEqual(appTitleEvidence(after,before,"Application 3"),["Application 3","6 Items"]);
  assert.deepEqual(appTitleEvidence(before,before,"Application 3"),[]);
  const wrong=view([["Different App",230,170],["No Recordings",230,640]]);
  assert.deepEqual(appTitleEvidence(wrong,before,"Application 3"),[]);
  after.state.overlay="dialog";assert.deepEqual(appTitleEvidence(after,before,"Application 3"),[]);
});
test("layout uses frame-relative geometry across resolutions",()=>{
  const v=home();v.frame.width*=1.5;v.frame.height*=1.5;
  for(const e of v.elements){e.center.x*=1.5;e.center.y*=1.5;for(const k of ["left","top","width","height"] as const)e.bounds[k]*=1.5;}
  assert.equal(navigationLayout(v).home,true);
});
test("exact app labels use one grounded operation without a per-app dictionary",()=>{
  const v=view([["Q App Library",330,190],["Cancel",540,190],["Unseen Brand 47",330,430],["Weather",330,590]]);
  assert.equal(navigationLayout(v).catalogMode,"labeled_list");
  assert.deepEqual(catalogEntries(v),["Unseen Brand 47","Weather"]);
  const d=localAppDecision("打开 Unseen Brand 47",v,[])!;
  assert.equal(d.step?.operation,"open_app");assert.equal(d.step?.text,"Unseen Brand 47");
  assert.equal(decisionRequest(d).expect.appTitle,"Unseen Brand 47");
  assert.equal(localAppDecision("打开 Unseen Brand 47 然后发送消息",v,[]),null);
  assert.equal(localAppDecision("open Unseen Brand 47 and send a message",v,[]),null);
  assert.equal(localAppDecision("打开设置 通用 关于手机 查看手机配置",v,[]),null);
  assert.equal(localAppDecision("打开设置查看手机配置",v,[]),null);
});
test("catalog search cannot reset a labeled list; missing apps scroll toward their name",()=>{
  const v=view([["Q App Library",330,190],["Cancel",540,190],["Settings",330,420],["Stocks",330,550],["Tips",330,680]]);
  assert.throws(()=>selectAction({type:"tap_text",text:"App Library"},v,profile),/already open/i);
  assert.equal(localAppDecision("打开 V2BOX",v,[])!.step?.direction,"up");
  assert.equal(localAppDecision("打开 Books",v,[])!.step?.direction,"down");
  assert.equal(localAppDecision("打开相册",v,[]),null); // Translation still belongs to the planner.
  const open=localAppDecision("打开 V2BOX",catalog(),[])!;
  assert.equal(open.step?.verification,"catalog");assert.equal(open.step?.completesObjective,null);
});
test("Home exits the observed OS catalog horizontally instead of repeating an edge gesture",()=>{
  const d=localHomeDecision("返回主页",catalog(),[])!;
  assert.equal(d.step?.operation,"swipe");assert.equal(d.step?.direction,"right");
  assert.deepEqual(stepCapabilities(d),["swipe"]);assert.equal(decisionRequest(d).expect.launcher,true);
  d.step!.direction="up";assert.throws(()=>decisionRequest(d),/Invalid grounded navigation/);
});
test("magnifier normalization is restricted to known OS search labels, never app names",()=>{
  assert.equal(canonicalLabel("Q App Library"),canonicalLabel("App Library"));
  assert.equal(canonicalLabel("Q Search"),canonicalLabel("Search"));
  assert.notEqual(canonicalLabel("Q Brand"),canonicalLabel("Brand"));
  assert.notEqual(canonicalLabel("V2BOX"),canonicalLabel("V2"));
});
test("launcher clicks use the uniquely observed icon above its caption, never a fixed text offset",()=>{
  const v=home(),label=v.elements[3],center={x:label.center.x+2,y:label.center.y-53};
  const icon={role:"icon" as const,label:"unlabeled icon",confidence:.85,center,bounds:{left:center.x-35,top:center.y-35,width:70,height:70},source:"local_edges" as const,edgeDensity:.4,localContrast:40};
  assert.throws(()=>selectAction({type:"open_app",text:label.text},v,profile),/No unique visible icon/);
  v.affordances=[icon];assert.equal(launcherIconTarget(v,label.text),icon);
  const action=selectAction({type:"open_app",text:label.text},v,profile);assert.equal(action.type,"tap");
  if(action.type==="tap")assert.deepEqual(action.point,cameraToScreen(profile,center));
  assert.equal(localAppDecision(`open ${label.text}`,v,[])?.step?.operation,"open_app");
  v.affordances.push({...icon,center:{x:center.x+1,y:center.y}});
  assert.equal(launcherIconTarget(v,label.text),null); // Ambiguity stops, never choose an arbitrary neighbor.
});
test("an adjacent row's icon cannot bind to a caption even when its detected component is tall",()=>{
  const v=home(),label=v.elements[7];
  v.affordances=[{role:"icon",label:"previous row icon",confidence:.95,center:{x:label.center.x,y:label.center.y-190},bounds:{left:label.center.x-60,top:label.center.y-245,width:120,height:120},source:"local_edges",edgeDensity:.5,localContrast:60}];
  assert.equal(launcherIconTarget(v,label.text),null);
  assert.throws(()=>selectAction({type:"open_app",text:label.text},v,profile),/No unique visible icon/);
  const d=localAppDecision(`open ${label.text}`,v,[])!;
  assert.equal(d.step?.operation,"swipe");assert.equal(d.step?.verification,"observe");assert.equal(d.step?.completesObjective,null);
});
test("an explicit Home goal can leave a dialog without granting permission or tapping behind it",()=>{
  const v=view([["Notification Request",330,430],["Allow",430,570],["Don't Allow",270,570]]);v.state.overlay="dialog";
  const p={...profile,navigation:{home:{strategy:"screen-swipe" as const,startPoint:{x:360,y:1530},endPoint:{x:360,y:1240},durationMs:250,source:"ios-face-id-home-v1" as const}}};
  const d=localHomeDecision("返回主页",v,[])!;assert.equal(d.step?.operation,"home");
  const request=decisionRequest(d);assert.equal(request.require?.overlay,undefined);assert.equal(request.expect.overlay,"none");
  assert.equal(selectAction(request.intent,v,p).type,"phone_key");
  assert.throws(()=>selectAction({type:"tap_text",text:"Allow"},v,p),/overlay/);
});
test("catalog icon binding uses the same row, not the icon above a launcher caption",()=>{
  const v=view([["App Library",330,190],["Cancel",540,190],["Example",330,500],["Next",330,610]]);
  v.affordances=[{role:"icon",label:"row icon",confidence:.95,center:{x:260,y:502},bounds:{left:230,top:472,width:60,height:60},source:"local_edges",edgeDensity:.5,localContrast:80}];
  assert.equal(catalogIconTarget(v,"Example"),v.affordances[0]);
  const action=selectAction({type:"open_app",text:"Example"},v,profile);
  if(action.type!=="tap")assert.fail("Expected tap");assert.deepEqual(action.point,cameraToScreen(profile,{x:260,y:502}));
  v.affordances[0].center.y=400;assert.equal(catalogIconTarget(v,"Example"),null);
});
