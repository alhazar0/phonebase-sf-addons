import test from 'node:test';import assert from 'node:assert/strict';
import {validateMessageDraft,assessMessageResult,messageSendRequested,type MessageEffect} from './message-effect';import type {LocalView} from './executor';
const spec:MessageEffect={targetId:'t2',recipient:'10086',body:'hi',recipientRegion:{left:.1,top:.1,right:.8,bottom:.2},composerRegion:{left:.1,top:.5,right:.8,bottom:.6},outgoingRegion:{left:.1,top:.25,right:.8,bottom:.4}};
function view(seq:number,outgoing=false):LocalView {return {deviceId:'phone',frame:{sequence:seq,capturedAt:seq,width:1000,height:1000},timing:{ocrCacheHit:false,ocrCapturedAt:seq},state:{overlay:'none',keyboard:true},elements:[['10086',150],['hi',outgoing?300:550]].map(([text,y],i)=>({id:String(i),role:'text',text,confidence:1,center:{x:400,y},bounds:{left:380,top:Number(y)-10,width:40,height:20}}))} as LocalView;}
test('draft verification binds exact user-requested recipient and body in two current regions',()=>{
  assert.doesNotThrow(()=>validateMessageDraft(spec,'给10086发hi',[view(1),view(2)]));
  assert.throws(()=>validateMessageDraft({...spec,recipient:'10010'},'给10086发hi',[view(1),view(2)]),/literal/);
  assert.throws(()=>validateMessageDraft({...spec,recipient:'100'},'给10086发hi',[view(1),view(2)]),/literal/);
  assert.throws(()=>validateMessageDraft(spec,'准备给10086发hi，不发送',[view(1),view(2)]),/authorize/);
  assert.equal(messageSendRequested('只准备草稿，不发'),false);
  for(const goal of ['draft only, send hi to 10086','send hi to 10086, do not send','准备给10086发hi，暂不发'])assert.equal(messageSendRequested(goal),false);
  const labeled=[view(1),view(2)];labeled.forEach(v=>v.elements[0].text='To: 10086');
  assert.doesNotThrow(()=>validateMessageDraft(spec,'给10086发hi',labeled));
  labeled.forEach(v=>v.elements[0].text='Other: 10086');
  assert.throws(()=>validateMessageDraft(spec,'给10086发hi',labeled),/Exact recipient/);
  assert.throws(()=>validateMessageDraft(spec,'给10086发hi',[view(1),view(1)]),/independent/);
});
test('draft text, a preexisting bubble and an explicit send error cannot prove sending',()=>{
  assert.equal(assessMessageResult(spec,view(3)).met,false);
  assert.equal(assessMessageResult(spec,view(3,true)).met,true);
  const old=view(1,true);old.elements.push({...old.elements[1],id:'draft',center:{x:400,y:550}});
  assert.throws(()=>validateMessageDraft(spec,'给10086发hi',[old,{...old,frame:{...old.frame,sequence:2,capturedAt:2},timing:{...old.timing,ocrCapturedAt:2}}]),/duplicate/);
  const failed=view(3,true);failed.elements.push({...failed.elements[1],id:'error',text:'Not Delivered'});assert.equal(assessMessageResult(spec,failed).met,false);
  assert.equal(assessMessageResult(spec,view(3,true)).deliveryVerified,false);
});
