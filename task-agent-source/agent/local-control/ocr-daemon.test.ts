import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough,Writable} from "node:stream";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {VisionOcrDaemon} from "../vision-ocr";

test("OCR pipe failure rejects the read instead of crashing the task with an unhandled EPIPE",async()=>{
  const child=Object.assign(new EventEmitter(),{stdin:new Writable({write(_chunk,_encoding,callback){callback(Object.assign(new Error("write EPIPE"),{code:"EPIPE"}));}}),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
  const listeners=process.listenerCount("exit");let stops=0;
  const daemon=new VisionOcrDaemon(child as unknown as ChildProcessWithoutNullStreams,()=>{stops++;});
  await assert.rejects(daemon.recognize(Buffer.from("test"),"literal"),/EPIPE/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stops,1);assert.equal(process.listenerCount("exit"),listeners);
  await assert.rejects(daemon.recognize(Buffer.from("test"),"literal"),/unavailable/);
  child.emit("exit",1,null);daemon.stop();assert.equal(stops,1);
});

test("aborted OCR reads do not write bytes and daemon shutdown removes its process listener",async()=>{
  let writes=0;
  const child=Object.assign(new EventEmitter(),{stdin:new Writable({write(_chunk,_encoding,callback){writes++;callback();}}),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
  const count=process.listenerCount("exit"),daemon=new VisionOcrDaemon(child as unknown as ChildProcessWithoutNullStreams,()=>{});
  await assert.rejects(daemon.recognize(Buffer.from("test"),"literal",AbortSignal.abort()));
  assert.equal(writes,0);daemon.stop();assert.equal(process.listenerCount("exit"),count);
});
