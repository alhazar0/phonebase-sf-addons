import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {request as httpRequest} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {TaskConsoleManager} from "./manager";
import {createTaskConsoleServer} from "./http";
test("HTTP console GETs never launch, POST is idempotent, and cross-site/host attacks cannot control hardware",async t=>{
  const root=await mkdtemp(join(tmpdir(),"screenhand-console-http-"));let launches=0,stops=0;
  const manager=new TaskConsoleManager(root,()=>{launches++;return {stop:()=>{stops++;},done:new Promise(()=>{})};});await manager.initialize();
  const server=createTaskConsoleServer(manager,{devices:async()=>[{id:"test-arm",connected:true,homed:true,ready:true}],frame:async()=>Buffer.from([255,216,255,217]),plannerConfigured:true,model:"test-no-model"});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  for(const path of ["/health","/devices","/runs","/devices/test-arm/frame"]){const r=await fetch(base+path);assert.equal(r.status,200);await r.arrayBuffer();}assert.equal(launches,0);
  const task={id:randomUUID(),deviceId:"test-arm",goal:"返回主页",mode:"preview"};
  const send=(path:string,headers:Record<string,string>={},body=JSON.stringify(task))=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...headers},body});
  assert.equal((await send("/runs",{origin:"https://evil.example"})).status,403);
  // Node fetch overwrites Host; use a raw HTTP client to really exercise DNS rebinding protection.
  const spoofedHost=await new Promise<number|undefined>((resolve,reject)=>{
    const req=httpRequest(`${base}/runs`,{method:"POST",headers:{host:"evil.example","content-type":"application/json"}},res=>{res.resume();resolve(res.statusCode);});
    req.on("error",reject);req.end(JSON.stringify(task));
  });assert.equal(spoofedHost,403);
  assert.equal((await send("/runs",{"sec-fetch-site":"cross-site"})).status,403);
  assert.equal((await send("/runs",{"content-type":"text/plain"})).status,415);
  assert.equal((await send("/runs",{},"x".repeat(9000))).status,413);assert.equal(launches,0);
  for(let i=0;i<2;i++)assert.equal((await send("/runs",{origin:"http://127.0.0.1:3011"})).status,202);assert.equal(launches,1);
  assert.equal((await fetch(`${base}/runs/${task.id}`)).status,200);assert.equal(launches,1);
  assert.equal((await send(`/runs/${task.id}/notes`,{},JSON.stringify({text:"观察到无响应"}))).status,200);
  assert.equal((await send(`/runs/${task.id}/stop`,{},"{}")).status,200);assert.equal(stops,1);
  assert.equal((await send(`/runs/${task.id}/stop`,{},"{}")).status,200);assert.equal(stops,1);
  const downloaded=await fetch(`${base}/runs/${task.id}/report`);assert.match(downloaded.headers.get("content-disposition")!,/attachment/);
  assert.equal((await downloaded.json()).run.notes[0].text,"观察到无响应");
});
