import assert from "node:assert/strict";
import test from "node:test";
import { actionContextReader } from "./action-context";
test("action context uses GET, filters device/age, and never exposes coordinates or receipt result bodies",async()=>{
  const now=Date.now();let calls=0;
  const receipt={id:"action-one",deviceId:"arm",actionType:"tap",status:"completed",updatedAt:now-10,result:{text:"PRIVATE",x:200,y:300},actor:"PRIVATE"};
  const read=actionContextReader("http://127.0.0.1:3013",async(_url,init)=>{
    calls++;assert.equal(init?.method,"GET");return Response.json({receipts:[receipt,{...receipt,id:"action-other",deviceId:"other"},{...receipt,id:"action-old",updatedAt:now-31000}]});
  });
  const r=await read("arm",AbortSignal.timeout(1000));assert.equal(r.length,1);assert.equal(r[0].visualVerified,false);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE|actor|result|200|300/);
  await assert.rejects(read("../arm",AbortSignal.timeout(1000)));assert.equal(calls,1);
  assert.throws(()=>actionContextReader("https://example.com"));
});
