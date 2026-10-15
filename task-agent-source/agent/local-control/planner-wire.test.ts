import assert from "node:assert/strict";
import test from "node:test";
import {decodePlannerDecision,decisionRequest,plannerWireDecisionSchema} from "./autonomous-planner";

const decision=(step:unknown)=>({kind:"action",reason:"当前导航",resultKind:"visual",navigationTarget:"Settings",
  objectives:["打开设置并查看配置"],requiredCapabilities:[],achieved:[],step,finalEvidence:[]});
test("minimal application navigation constructs the full unchanged verification contract",()=>{
  const parsed=decodePlannerDecision(decision({operation:"open_app",text:"Settings",beforeTexts:["App Library","Settings"],completesObjective:null}));
  const request=decisionRequest(parsed);
  assert.deepEqual(request.expect,{appTitle:"Settings",overlay:"none",keyboard:false});
  assert.equal(parsed.step?.completesObjective,null);
  assert.deepEqual(parsed.step?.afterTexts,[]);
});
test("home and catalog have host-owned distinct postconditions",()=>{
  const home=decodePlannerDecision(decision({operation:"home",beforeTexts:["Title","Body"],completesObjective:0}));
  assert.deepEqual(decisionRequest(home).expect,{launcher:true,overlay:"none",keyboard:false});
  const catalog=decodePlannerDecision(decision({operation:"open_catalog",text:"App Library",beforeTexts:["App Library","Utilities"]}));
  assert.deepEqual(decisionRequest(catalog).expect,{catalogList:true,overlay:"none"});
  assert.equal(catalog.step?.completesObjective,null);
});
test("navigation wire rejects injected coordinates and conflicting outcome promises instead of silently weakening them",()=>{
  const step={operation:"open_app",text:"Settings",beforeTexts:["App Library","Settings"],completesObjective:null};
  for(const extra of [{afterTexts:["General","About"]},{point:{x:1,y:2}},{allowOverlay:true},{verification:"observe"}])
    assert.equal(plannerWireDecisionSchema.safeParse(decision({...step,...extra})).success,false);
  assert.equal(plannerWireDecisionSchema.safeParse(decision({...step,beforeTexts:["Settings"]})).success,false);
});
