import test from 'node:test';import assert from 'node:assert/strict';
import {fillVisibleField,type FieldRead} from './field-entry';import type {FieldSnapshot} from './input-state';import type {ControlDependencies,LocalView} from './executor';import type {ScreenHandCalibrationProfile} from '../calibration-profile';import type {VisibleKeyboard} from './visible-keyboard';
const profile:ScreenHandCalibrationProfile={id:'fixture',deviceId:'arm',verified:true,verifiedAt:'2026-09-08',frame:{width:720,height:1280},screen:{width:720,height:1280},imagePoints:[{x:0,y:0},{x:720,y:0},{x:720,y:1280},{x:0,y:1280}],machinePoints:[{x:70,y:160},{x:10,y:160},{x:10,y:20},{x:70,y:20}],safeMachineBounds:{minimumX:9,maximumX:71,minimumY:19,maximumY:161},tap:{hoverZ:1,touchZ:9.5,zStep:.5,feed:3000,dwellMs:40}};
function fixture(initial:string,options:{caret?:number;uncertain?:boolean;selectionAvailable?:boolean;queryResult?:boolean;duplicateAnchor?:boolean}={}){
  let value=initial,caret=options.caret??initial.length,selection:'none'|'partial'|'all'='none',menu=false,seq=0,at=Date.now(),keyCount=0;
  const actions:string[]=[],keys:VisibleKeyboard['keys']={};[...'abcdefghijklmnopqrstuvwxyz'].forEach((k,i)=>keys[k]={x:150+i*15,y:850});keys.space={x:600,y:950};
  const keyboard:VisibleKeyboard={mode:'letters',keys,uppercase:false,top:800,pitch:40,anchors:26};
  const element=(text:string,x:number,y:number,id:string)=>({id,role:'text' as const,text,confidence:1,center:{x,y},bounds:{left:x-20,top:y-10,width:Math.max(40,text.length*12),height:20}});
  const observe=async():Promise<LocalView>=>{
    at=Math.max(Date.now(),at+1);const elements=[element('Editor',260,170,'title'),element('Cancel',550,170,'cancel'),element(value||'First name',200,300,'field')];
    if(menu&&options.selectionAvailable!==false)elements.push(element('Select All',260,430,'select-all'));
    if(options.duplicateAnchor)elements.push(element(initial,260,450,'duplicate'));
    if(options.queryResult&&keyCount){elements.push(element('Top Hit',200,180,'top'),element('Contacts',200,400,'result'),element('Suggestions',200,500,'suggestions'));}
    return {deviceId:'arm',frame:{width:720,height:1280,sequence:++seq,capturedAt:at,image:'mock'},elements,state:{page:'unknown',source:'current_evidence',overlay:'none',keyboard:true,candidates:[],evidence:[],stableFrames:2,method:'local-feature-rules+temporal',scoreIsProbability:false},timing:{fetchMs:0,observationMs:0,ocrMs:0,ocrCacheHit:false,ocrCapturedAt:at,ocrAgeMs:0,stateMs:0,totalMs:0,frameAgeMs:0}};
  };
  const deps:ControlDependencies={deviceId:'arm',observe,getCalibration:async()=>profile,getDevice:async()=>({id:'arm',connected:true,status:'running',screen:null,state:{grbl:{homed:true,state:'Idle'}},capabilities:{actions:{tap:{available:true},long_press:{available:true}}}}),act:async action=>{
    if(action.type==='long_press'){actions.push('long_press');menu=true;selection='partial';}
    else if(action.type==='tap'){
      if(Math.abs(action.point.y-430)<10){actions.push('select_all');selection='all';menu=false;}
      else if(Math.abs(action.point.y-300)<20){actions.push('focus_end');caret=value.length;selection='none';menu=false;}
      else {const key=Object.entries(keys).find(([,p])=>Math.abs(p.x-action.point.x)<1&&Math.abs(p.y-action.point.y)<1)?.[0];if(!key)throw new Error('Unknown test key');actions.push(key);const char=key==='space'?' ':key;
        if(selection==='all'){value=char;caret=1;selection='none';}else{value=value.slice(0,caret)+char+value.slice(caret);caret++;}keyCount++;if(options.uncertain)throw new Error('Receipt lost after key submission');}
    }else throw new Error('Unexpected action');
    return {receipt:{id:`r${actions.length}`,status:'completed'},elapsedMs:1,response:{}};
  }};
  const readField=async(v:LocalView,_b:unknown,expected:string):Promise<FieldRead>=>{
    const raw=options.queryResult&&keyCount?'Q Contacts - Open':value||'First name';
    const snapshot:FieldSnapshot={sequence:v.frame.sequence,capturedAt:v.frame.capturedAt,rawText:raw,value:options.queryResult&&keyCount?raw:value,kind:value?'value':'placeholder',caret:caret===value.length?'end':'inside',selection,confidence:1};
    return {sequence:v.frame.sequence,capturedAt:v.frame.capturedAt,text:raw,expected,matched:value===expected,snapshot,textBounds:{left:180,top:290,width:Math.max(40,value.length*12),height:20}};
  };
  return {run:(desired:string,purpose:'message'|'query'='message')=>fillVisibleField(deps,initial||'First name',desired,AbortSignal.timeout(15000),undefined,{readKeyboard:async()=>keyboard,readField,purpose,targetRegion:options.duplicateAnchor?{left:.2,top:.2,right:.6,bottom:.27}:undefined}),actions,value:()=>value};
}
test('existing exact contents are idempotent and send no focus or key',async()=>{const f=fixture('hi');const r=await f.run('hi');assert.equal(r.status,'verified',r.error);assert.deepEqual(f.actions,[]);});
test('the bound field, not a duplicate menu value, is continued',async()=>{const f=fixture('alex',{duplicateAnchor:true}),r=await f.run('alexander');assert.equal(r.status,'verified',r.error);assert.equal(f.value(),'alexander');assert.deepEqual(f.actions,[...'ander']);});
test('existing prefix with an interior caret focuses the end then types only the suffix',async()=>{
  const f=fixture('hi',{caret:1}),r=await f.run('hi how are you');assert.equal(r.status,'verified',r.error);assert.equal(f.value(),'hi how are you');assert.equal(f.actions[0],'focus_end');assert.equal(f.actions.filter(a=>a==='focus_end').length,1);assert.deepEqual(f.actions.slice(1),[...' how are you'].map(c=>c===' '?'space':c));
});
test('different contents require observed Select All and verification before replacing once',async()=>{
  const f=fixture('hi hhi'),r=await f.run('hi how');assert.equal(r.status,'verified',r.error);assert.equal(f.value(),'hi how');assert.deepEqual(f.actions.slice(0,2),['long_press','select_all']);assert.equal(f.actions.filter(a=>a==='long_press').length,1);
});
test('missing selection and a lost key receipt cannot cause blind replacement or replay',async()=>{
  const selection=fixture('wrong',{selectionAvailable:false}),r=await selection.run('alex');assert.equal(r.status,'blocked');assert.equal(selection.value(),'wrong');assert.deepEqual(selection.actions,['long_press']);
  const uncertain=fixture('',{uncertain:true}),u=await uncertain.run('alex');assert.equal(u.status,'action_uncertain');assert.equal(u.recovery,'stop');assert.deepEqual(uncertain.actions,['a']);
});
test('a query yields as soon as its independent result appears instead of requiring literal completion',async()=>{
  const f=fixture('',{queryResult:true}),r=await f.run('contacts','query');assert.equal(r.status,'result_available',r.error);assert.deepEqual(f.actions,['c']);assert.equal(r.typing?.status,'yielded');
});
