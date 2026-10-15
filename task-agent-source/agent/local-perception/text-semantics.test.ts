import assert from "node:assert/strict";
import test from "node:test";
import { buildTextDocument, matchTextDocuments, OpenRouterTextClassifier, TextSemanticAssistant, textDocumentKey, validateTextJudgment, type TextJudgment } from "./text-semantics";
import type { PerceptionSnapshot } from "./service";
import { InferenceError } from "./inference-error";

function input(texts=["Settings","Notifications","Privacy & Security"]) {
  const now=Date.now();
  return {deviceId:"arm",frame:{width:720,height:1280,sequence:10,capturedAt:now,image:"DO_NOT_UPLOAD_JPEG"},
    elements:texts.map((text,i)=>({id:String(i),role:"text" as const,text,confidence:1,center:{x:300,y:200+i*70},bounds:{left:200,top:190+i*70,width:200,height:20}})),
    state:{page:"unknown",source:"insufficient_evidence",keyboard:false,overlay:"none"},timing:{ocrCapturedAt:now},
  } as unknown as PerceptionSnapshot;
}
const result:TextJudgment={app:"Settings",pageKind:"settings",layout:"vertical_list",headingId:"t0",evidenceIds:["t0","t1","t2"],summary:"设置标题下方是多行设置列表。"};
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test("text document excludes image, weak OCR, status clock and arbitrary metadata",()=>{
  const i=input(["Settings","Notifications","8:09"]);i.elements[2].center.y=120;
  const document=buildTextDocument(i);assert.equal(document.nodes.length,2);
  assert.doesNotMatch(JSON.stringify(document),/DO_NOT_UPLOAD|8:09|deviceId|capturedAt/);
  i.elements[1].confidence=.1;assert.equal(buildTextDocument(i).nodes.length,1);
});
test("semantic evidence must cite at least two distinct real anchors",()=>{
  const document=buildTextDocument(input());
  assert.deepEqual(validateTextJudgment(result,document),result);
  assert.throws(()=>validateTextJudgment({...result,evidenceIds:["invented","t0"]},document));
  assert.throws(()=>validateTextJudgment({...result,evidenceIds:["t0"]},document));
  assert.throws(()=>validateTextJudgment({...result,headingId:"t9"},document));
  assert.throws(()=>validateTextJudgment({...result,action:"tap"},document));
  assert.throws(()=>validateTextJudgment({...result,evidenceIds:["t0","t0"]},document));
});
test("document key invalidates changed text, geometry and overlays",()=>{
  const i=input();const key=textDocumentKey(buildTextDocument(i));
  i.elements[1].center.y+=100;i.elements[1].bounds.top+=100;
  assert.notEqual(textDocumentKey(buildTextDocument(i)),key);
  const other=input(["Settings","Wrong page"]);assert.notEqual(textDocumentKey(buildTextDocument(other)),key);
  const overlay=input();overlay.state.overlay="dialog";assert.notEqual(textDocumentKey(buildTextDocument(overlay)),key);
});
test("disabled or locally sufficient observations never call a model",()=>{
  let calls=0;const assistant=new TextSemanticAssistant({model:"test",classify:async()=>{calls++;return result;}});
  const i=input();i.state.page="settings";i.state.source="current_evidence";
  assert.equal(assistant.observe(i).status,"local_sufficient");assert.equal(calls,0);
  assert.equal(assistant.request(i,"explicit-local").status,"local_sufficient");assert.equal(calls,0);
  assert.equal(new TextSemanticAssistant(null).observe(input()).status,"disabled");
});
test("inference is nonblocking, single-flight and cached only for matching evidence",async()=>{
  let resolve!:(value:TextJudgment)=>void;let calls=0;
  const assistant=new TextSemanticAssistant({model:"test",classify:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  assert.equal(assistant.request(input(),"one-request").status,"pending");
  assert.equal(assistant.observe(input()).status,"pending");assert.equal(calls,1);
  resolve(result);await settle();const cached=assistant.observe(input());
  assert.equal(cached.status,"ready");assert.equal(cached.currentEvidenceMatched,true);assert.equal(cached.modelCalls,1);
  assert.equal(assistant.observe(input(["Other","Page"])).judgment,undefined);
  assistant.close();
});
test("stale camera or OCR cannot reuse a semantic result",async()=>{
  const assistant=new TextSemanticAssistant({model:"test",classify:async()=>result});
  assistant.request(input(),"freshness");await settle();
  const stale=input();stale.timing.ocrCapturedAt-=3000;assert.equal(assistant.observe(stale).status,"insufficient_text");
  const old=input();old.frame.capturedAt-=3000;assert.equal(assistant.observe(old).judgment,undefined);
});
test("errors are redacted and do not retry every polling tick",async()=>{
  let calls=0;const assistant=new TextSemanticAssistant({model:"test",classify:async()=>{calls++;throw new Error("secret provider details");}});
  assistant.request(input(),"error-once");await settle();
  const status=assistant.observe(input());assert.equal(status.status,"error");assert.doesNotMatch(status.error!,/secret/);assert.equal(calls,1);
});
test("service model budget cannot be exceeded",async()=>{
  let now=Date.now();const assistant=new TextSemanticAssistant({model:"test",classify:async()=>result},()=>now,1);
  assistant.request(input(),"budget-first");await settle();now+=6000;
  const i=input(["Other","New page"]);i.frame.capturedAt=now;i.timing.ocrCapturedAt=now;
  assert.equal(assistant.request(i,"budget-second").status,"budget_exhausted");assert.equal(assistant.modelCalls,1);
});

test("hundreds of observations and elapsed minutes never submit or retry a model",async()=>{
  let now=Date.now();let calls=0;
  const assistant=new TextSemanticAssistant({model:"test",classify:async()=>{calls++;return result;}},()=>now);
  const fresh=()=>{const i=input();i.frame.capturedAt=now;i.timing.ocrCapturedAt=now;return i;};
  for(let n=0;n<200;n++){now+=1000;assert.equal(assistant.observe(fresh()).status,"idle");}
  assert.equal(calls,0);
  assistant.request(fresh(),"explicit");await settle();now+=61000;
  assert.equal(assistant.observe(fresh()).status,"ready");assert.equal(calls,1);
  const changed=fresh();changed.elements[1].text="Changed";
  for(let n=0;n<100;n++)assert.equal(assistant.observe(changed).status,"stale");
  assert.equal(calls,1);
});

test("duplicate request IDs, new IDs while pending and later transport retries cannot duplicate a call",async()=>{
  let now=Date.now();let calls=0;let resolve!:(value:TextJudgment)=>void;
  const assistant=new TextSemanticAssistant({model:"test",classify:()=>{calls++;return new Promise(r=>{resolve=r;});}},()=>now);
  const i=input();
  assistant.request(i,"same-id");assert.equal(assistant.request(i,"same-id").deduplicated,true);
  assert.equal(assistant.request(i,"double-click-new-id").status,"cooldown");assert.equal(calls,1);
  resolve(result);await settle();now+=61000;i.frame.capturedAt=now;i.timing.ocrCapturedAt=now;
  i.elements[1].text="Changed";
  assistant.request(i,"same-id");assistant.request(i,"double-click-new-id");assert.equal(calls,1);
  assert.equal(assistant.request({...i,deviceId:"other"},"same-id").status,"error");assert.equal(calls,1);
});

test("tiny box jitter and row-order changes remap citations without a new request",async()=>{
  const assistant=new TextSemanticAssistant({model:"test",classify:async()=>result});
  assistant.request(input(),"jitter");await settle();
  const moved=input();for(const e of moved.elements){e.bounds.left+=2;e.bounds.top+=3;}
  assert.equal(assistant.observe(moved).status,"ready");assert.equal(assistant.modelCalls,1);
  const doc=buildTextDocument(input());const reordered={...doc,nodes:[...doc.nodes].reverse().map((n,i)=>({...n,id:`new${i}`}))};
  assert.equal(matchTextDocuments(doc,reordered)?.get("t0"),"new2");
  const changed=input();changed.elements[1].bounds.top+=80;
  assert.equal(assistant.observe(changed).judgment,undefined);
  changed.elements[1].bounds.top-=80;changed.state.overlay="dialog";
  assert.equal(assistant.observe(changed).judgment,undefined);
});

test("sequence rollback, resolution changes and shutdown invalidate semantic results",async()=>{
  for(const mutate of [(i:PerceptionSnapshot)=>{i.frame.sequence=9;},(i:PerceptionSnapshot)=>{i.frame.width=1080;}]) {
    const a=new TextSemanticAssistant({model:"test",classify:async()=>result});a.request(input(),"reset");await settle();
    const i=input();mutate(i);assert.equal(a.observe(i).judgment,undefined);assert.equal(a.modelCalls,1);
    a.close();assert.equal(a.request(input(),"after-close").status,"disabled");assert.equal(a.modelCalls,1);
  }
});

test("failure remains inert until a new explicit request; records redact text and secrets",async()=>{
  let now=Date.now();let calls=0;const events:unknown[]=[];
  const a=new TextSemanticAssistant({model:"test",classify:async()=>{calls++;throw new Error("secret provider text");}},()=>now,30,e=>events.push(e));
  a.request(input(),"fail");await settle();now+=61000;
  const i=input();i.frame.capturedAt=now;i.timing.ocrCapturedAt=now;
  for(let n=0;n<20;n++)assert.equal(a.observe(i).status,"error");
  assert.equal(calls,1);a.request(i,"explicit-retry");await settle();assert.equal(calls,2);
  const records=a.history("arm");assert.equal(records[1].reason,"manual_retry");assert.equal(records[1].outcome,"failed");
  assert.doesNotMatch(JSON.stringify(events),/Settings|Notifications|secret|DO_NOT_UPLOAD/);
  records[0].outcome="validated";assert.equal(a.history("arm")[0].outcome,"failed");
});

test("request-ID memory is bounded even when every request is blocked locally",()=>{
  let calls=0;const a=new TextSemanticAssistant({model:"test",classify:async()=>{calls++;return result;}});
  const i=input();i.state.page="settings";i.state.source="current_evidence";
  for(let n=0;n<128;n++)a.request(i,`id-${n}`);
  assert.equal(a.request(i,"overflow").status,"budget_exhausted");assert.equal(calls,0);
});
test("HTTP classifier sends only bounded text, JSON schema and no action tools",async()=>{
  const document=buildTextDocument(input());let body:Record<string,unknown>|undefined;
  const classifier=new OpenRouterTextClassifier({apiKey:"test-key",fetcher:(async(url,init)=>{
    assert.equal(String(url),"https://openrouter.ai/api/v1/chat/completions");assert.equal(init?.redirect,"error");body=JSON.parse(String(init?.body));
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(result)}}]});
  }) as typeof fetch});
  assert.deepEqual(await classifier.classify(document),result);assert.equal(body?.tools,undefined);
  assert.equal(body?.model,"google/gemini-3.8-flash");
  assert.equal(body?.temperature,undefined);
  assert.deepEqual(body?.reasoning,{effort:"low",exclude:true});
  assert.equal(body?.max_tokens,1024);
  assert.doesNotMatch(JSON.stringify(body),/DO_NOT_UPLOAD_JPEG|image_url|test-key/);
  assert.deepEqual((body?.provider as {zdr:boolean}).zdr,true);
  const format=body?.response_format as {json_schema:{schema:{properties:{evidenceIds:{maxItems:number}}}}};
  assert.equal(format.json_schema.schema.properties.evidenceIds.maxItems,6);
});
test("explicit legacy model keeps reasoning disabled without a fallback",async()=>{
  let body:Record<string,unknown>|undefined;
  const classifier=new OpenRouterTextClassifier({apiKey:"test",model:"google/gemini-2.5-flash-lite",fetcher:(async(_url,init)=>{
    body=JSON.parse(String(init?.body));return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(result)}}]});
  }) as typeof fetch});
  await classifier.classify(buildTextDocument(input()));
  assert.equal(body?.model,"google/gemini-2.5-flash-lite");assert.deepEqual(body?.reasoning,{enabled:false});
  assert.equal(body?.temperature,0);
});
test("truncated and invented model output is rejected",async()=>{
  for(const response of [{choices:[{finish_reason:"length",message:{content:"{}"}}]},
    {choices:[{finish_reason:"stop",message:{content:JSON.stringify({...result,evidenceIds:["t88","t99"]})}}]}]) {
    const classifier=new OpenRouterTextClassifier({apiKey:"test",fetcher:(async()=>Response.json(response)) as typeof fetch});
    await assert.rejects(classifier.classify(buildTextDocument(input())));
  }
});

test("shared document joins current text, shape, styling and position; motor history is never visual success",()=>{
  const i=input(["PHOTO","VIDEO"]);
  i.visual={accentText:["PHOTO","not visible"],targets:[{role:"control",label:"untrusted label",confidence:1,shape:"filled_circle",tone:"light",shapeScore:.95,
    center:{x:300,y:350},bounds:{left:270,top:320,width:60,height:60},source:"local_edges",edgeDensity:.4,localContrast:150}]};
  i.recentActions=[{id:"action-one",action:"tap",status:"completed",at:i.frame.capturedAt-50,visualVerified:false},
    {id:"action-future",action:"tap",status:"completed",at:i.frame.capturedAt+50,visualVerified:false}];
  const d=buildTextDocument(i);assert.equal(d.controls[0].shape,"filled_circle");
  assert.ok(d.relations.some(r=>r.controlId==="v0"&&r.relation==="below"&&r.textId==="t0"));
  assert.deepEqual(d.accentText,["PHOTO"]);assert.equal(d.recentActions.length,1);assert.equal(d.recentActions[0].visualVerified,false);
  assert.doesNotMatch(JSON.stringify(d),/untrusted label|DO_NOT_UPLOAD|action-future/);
  const changed=structuredClone(d);changed.controls=[];assert.equal(matchTextDocuments(d,changed),null);
  const moved=structuredClone(d);moved.controls[0].box[0]+=100;assert.equal(matchTextDocuments(d,moved),null);
  const styling=structuredClone(d);styling.accentText=[];assert.equal(matchTextDocuments(d,styling),null);
  const history=structuredClone(d);history.recentActions=[];assert.equal(matchTextDocuments(d,history),null);
});
test("model errors preserve safe distinct codes rather than claiming every failure is unsupported evidence",async()=>{
  const cases:Array<[string,typeof fetch]>=[
    ["http",async()=>new Response("PRIVATE",{status:429})],
    ["transport",async()=>{throw new TypeError("PRIVATE transport");}],
    ["timeout",async()=>{throw new DOMException("PRIVATE timeout","TimeoutError");}],
    ["invalid_json",async()=>Response.json({choices:[{finish_reason:"stop",message:{content:"NOT JSON PRIVATE"}}]})],
    ["invalid_schema",async()=>Response.json({choices:[{finish_reason:"stop",message:{content:"{}"}}]})],
    ["invalid_evidence",async()=>Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({...result,evidenceIds:["t9","t10"]})}}]})],
    ["incomplete",async()=>Response.json({choices:[{finish_reason:"length"}]})],
  ];
  for(const [code,fetcher] of cases) {
    const c=new OpenRouterTextClassifier({apiKey:"PRIVATE KEY",timeoutMs:120,fetcher});
    await assert.rejects(c.classify(buildTextDocument(input())),e=>e instanceof InferenceError&&e.code===code&&!e.message.includes("PRIVATE"));
    const a=new TextSemanticAssistant(c);a.request(input(),`error-${code}`);
    for(let n=0;n<10&&a.history("arm")[0].outcome==="pending";n++)await settle();
    assert.equal(a.history("arm")[0].errorCode,code);assert.equal(a.modelCalls,1);a.close();
  }
});
