import test from "node:test";
import assert from "node:assert/strict";
import {fieldValueMatches,fillVisibleField} from "./field-entry";
import {fieldRequest,autonomousDecisionSchema,decodePlannerDecision,plannerWireSchemaFor} from "./autonomous-planner";
import type {ControlDependencies} from "./executor";
import type {LocalView} from './executor';

test("field readback preserves case and every digit, excluding suggestions and neighbouring values",()=>{
  assert.equal(fieldValueMatches("alex","alex"),true);
  assert.equal(fieldValueMatches("Alex","alex"),false);
  assert.equal(fieldValueMatches("(187) 8787-8787","18787878787"),true);
  for(const actual of ["1878787878","18787878788","suggestion 18787878787","alex mobile 18787878787"]){
    assert.equal(fieldValueMatches(actual,"18787878787"),false);
  }
  assert.equal(fieldValueMatches("alexander","alex"),false);
  assert.equal(fieldValueMatches("Q alex","alex","Q Search"),true);
  assert.equal(fieldValueMatches("Q alex","alex","First name"),false);
  assert.equal(fieldValueMatches("Q camera - Open","c","Q Search"),false);
  assert.equal(fieldValueMatches("first Name","First name","First name"),true);
  assert.equal(fieldValueMatches("To: 10086","10086","To:"),true);
  assert.equal(fieldValueMatches("To: 10086","10010","To:"),false);
  assert.equal(fieldValueMatches("To: Hi!","hi!","To:"),false);
});

test("field contract cannot smuggle a commit, missing field, unicode or a guessed outcome",()=>{
  const d=autonomousDecisionSchema.parse({kind:"action",reason:"Input requested value",objectives:[],achieved:[],finalEvidence:[],
    step:{operation:"fill_field",text:"alex",field:"First name",inputPurpose:"form",direction:null,shape:null,beforeTexts:["New Contact"],afterTexts:[],afterKeyboard:null,completesObjective:null,allowOverlay:false}});
  assert.equal(fieldRequest(d).intent.text,"alex");
  for(const patch of [{field:null},{text:"alex\n"},{inputPurpose:null},{text:"你好"},{afterTexts:["Done"]},{completesObjective:0},{allowOverlay:true}]) {
    assert.throws(()=>fieldRequest({...d,step:{...d.step!,...patch}}));
  }
});

test("invalid field input produces no observation, focus tap or key",async()=>{
  let touched=false;
  const unexpected=async()=>{touched=true;throw new Error("unexpected hardware access");};
  const deps:ControlDependencies={deviceId:"arm",observe:unexpected,getDevice:unexpected,getCalibration:unexpected,act:unexpected};
  const r=await fillVisibleField(deps,"First name","alex\n",AbortSignal.timeout(1000));
  assert.equal(r.status,"blocked");assert.equal(touched,false);assert.equal(r.typing,undefined);
});

test('field names and existing values only identify the field; both reach desired-state reconciliation',()=>{
  for(const field of ['First name','hi','Hi','|hi']){
    const d=autonomousDecisionSchema.parse({kind:'action',reason:'Set desired text',objectives:[],achieved:[],finalEvidence:[],step:{operation:'fill_field',field,text:'hi how are you',inputPurpose:'message',beforeTexts:['New Message'],afterTexts:[],direction:null,shape:null,afterKeyboard:null,completesObjective:null,allowOverlay:false}});
    assert.equal(fieldRequest(d).intent.text,'hi how are you');
  }
});

test('set_field binds an observed node position when another menu contains the same word',()=>{
  const v={frame:{width:720,height:1280},state:{keyboard:true,overlay:'none'},elements:[300,500].map((y,i)=>({id:String(i),role:'text',text:'alex',confidence:1,center:{x:200,y},bounds:{left:180,top:y-10,width:40,height:20}}))} as LocalView;
  const d=decodePlannerDecision({kind:'action',reason:'Set the selected field',objectives:[],achieved:[],finalEvidence:[],step:{operation:'set_field',targetId:'t0',text:'alexander',inputPurpose:'form',beforeTexts:['alex','Editor']}});
  assert.throws(()=>fieldRequest(d),/source observation/);
  const r=fieldRequest(d,v);assert.equal(r.intent.field,'alex');assert.ok(r.intent.targetRegion!.bottom<.3);
  const schema=JSON.stringify(plannerWireSchemaFor({goal:'Set name',view:v,objectives:[],history:[],visibleTextEntry:true,capabilities:{inputText:true,tap:true,longPress:true,swipe:true,home:true}}));
  assert.match(schema,/set_field/);assert.doesNotMatch(schema,/"fill_field"/);
});
