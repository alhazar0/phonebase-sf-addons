import test from 'node:test';import assert from 'node:assert/strict';
import {bindObservedTarget,observedTarget,readRegion} from './interaction';
import {assessExpectation,type LocalView} from './executor';
import {decodePlannerDecision,decisionRequest,explorationRequest} from './autonomous-planner';
import type {ScreenHandCalibrationProfile} from '../calibration-profile';
const region={left:.5,top:.2,right:.85,bottom:.4};
function view(value='0'):LocalView{return {deviceId:'test',frame:{width:720,height:1280,sequence:1,capturedAt:1,image:''},state:{keyboard:false,overlay:'none'},elements:[{id:'out',role:'text',text:value,confidence:1,center:{x:520,y:360},bounds:{left:500,top:330,width:40,height:60}},{id:'key',role:'text',text:'8',confidence:1,center:{x:320,y:800},bounds:{left:300,top:780,width:40,height:40}}],timing:{ocrCapturedAt:1}} as LocalView;}
test('a keypad label cannot prove a displayed value, including duplicate 8s',()=>{
  const before=view(),after=view('8'),expect={displayText:{region,text:'8'},overlay:'none' as const};
  assert.equal(assessExpectation(expect,before,before,{} as ScreenHandCalibrationProfile).met,false);
  assert.equal(assessExpectation(expect,after,before,{} as ScreenHandCalibrationProfile).met,true);
  assert.equal(assessExpectation(expect,after,after,{} as ScreenHandCalibrationProfile).met,false);
  assert.equal(readRegion(before,region),'0');
});
test('the selected node binds a current control, not another equal label or a moved control',()=>{
  const old=view('8'),target=bindObservedTarget(old,'t1');
  assert.equal(observedTarget(old,target).id,'key');
  const moved=view('8');moved.elements[1].center.x=500;
  assert.throws(()=>observedTarget(moved,target),/moved/);
});
test('stateful wire requests retain spatial evidence and observation-only taps cannot complete',()=>{
  const base={kind:'action',reason:'Select current control',objectives:['Read result'],achieved:[],finalEvidence:[],step:{operation:'tap_node',targetId:'t1',result:{region,text:'8'},beforeTexts:['0','8'],completesObjective:0}};
  const d=decodePlannerDecision(base),request=decisionRequest(d,view());assert.equal(request.intent.type,'tap_observed');assert.deepEqual(request.expect.displayText,{region,text:'8'});
  const observe=decodePlannerDecision({...base,step:{...base.step,result:null}});assert.throws(()=>explorationRequest(observe,view()),/cannot promise/);
  observe.step!.completesObjective=null;assert.equal(explorationRequest(observe,view()).intent.type,'tap_observed');
});
