import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type AddressInfo } from "node:net";
import { createPerceptionServer } from "./http";
import { TextSemanticAssistant } from "./text-semantics";
import { type PerceptionSnapshot } from "./service";

async function fixture(t:TestContext) {
  let calls=0,observations=0;
  const semantics=new TextSemanticAssistant({model:"test-no-network",classify:async()=>{
    calls++;return {app:"Settings",pageKind:"settings",layout:"vertical_list",headingId:"t0",evidenceIds:["t0","t1"],summary:"设置列表"};
  }});
  const server=createPerceptionServer({devices:async()=>[],observe:async(deviceId)=>{
    observations++;const now=Date.now();
    return {ok:true,deviceId,frame:{width:720,height:1280,capturedAt:now,sequence:observations},timing:{ocrCapturedAt:now},
      state:{page:"unknown",source:"insufficient_evidence",keyboard:false,overlay:"none"},
      elements:["Settings","Notifications"].map((text,i)=>({id:String(i),text,confidence:1,
        center:{x:300,y:200+i*70},bounds:{left:200,top:190+i*70,width:200,height:20}})),
    } as PerceptionSnapshot;
  }},semantics);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{semantics.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post=(body:unknown,headers:Record<string,string>={})=>fetch(`${base}/semantics`,{method:"POST",
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  return {base,post,calls:()=>calls,observations:()=>observations};
}
test("GET polling including the legacy semantic=1 switch never invokes a model",async t=>{
  const f=await fixture(t);
  for(let i=0;i<40;i++){
    const response=await fetch(`${f.base}/observation?deviceId=arm&semantic=1`);
    assert.equal(response.status,200);assert.equal((await response.json()).semantic.status,"idle");
  }
  assert.equal(f.calls(),0);
});
test("explicit POST submits once; duplicate POSTs and subsequent GETs are read-only",async t=>{
  const f=await fixture(t);const body={deviceId:"arm",requestId:"one"};
  const responses=await Promise.all([f.post(body),f.post(body)]);
  for(const r of responses)assert.equal(r.status,200);
  for(let i=0;i<20;i++)await fetch(`${f.base}/observation?deviceId=arm&semantic=1`);
  assert.equal(f.calls(),1);
  const r=await fetch(`${f.base}/observation?deviceId=arm`);const p=await r.json();
  assert.equal(p.semantic.status,"ready");assert.equal(p.semantic.recentCalls[0].reason,"manual_initial");
  assert.equal(p.semantic.recentCalls[0].outcome,"validated");
});
test("cross-site, wrong content type, malformed and oversized requests never reach OCR or a model",async t=>{
  const f=await fixture(t);const body={deviceId:"arm",requestId:"one"};
  assert.equal((await f.post(body,{Origin:"https://example.com"})).status,403);
  assert.equal((await f.post(body,{"Sec-Fetch-Site":"cross-site"})).status,403);
  assert.equal((await f.post(body,{"Content-Type":"text/plain"})).status,415);
  assert.equal((await f.post({...body,action:"tap"})).status,400);
  assert.equal((await f.post({...body,requestId:"../bad"})).status,400);
  assert.equal((await f.post({...body,extra:"x".repeat(2100)})).status,413);
  assert.equal(f.observations(),0);assert.equal(f.calls(),0);
});
test("no GET inference endpoint or POST hardware endpoint exists",async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(`${f.base}/semantics`)).status,405);
  assert.equal((await fetch(`${f.base}/actions`,{method:"POST"})).status,405);
  assert.equal(f.calls(),0);assert.equal(f.observations(),0);
  const h=await (await fetch(`${f.base}/health`)).json();
  assert.equal(h.semanticTrigger,"explicit-post-only");assert.equal(h.physicalActionsAllowed,false);
});
