import test from "node:test";
import assert from "node:assert/strict";
import {normalTouchPressure} from "./touch-policy";
import type {AgentDevice} from "../general-agent-client";
import type {ScreenHandSemanticAction} from "../action-contract";
const tap:ScreenHandSemanticAction={type:"tap",point:{x:100,y:200},viewport:{width:720,height:1560},frameSequence:1};
function device(minimumTouchZ:number,maximumTouchZ:number):AgentDevice{return {id:"test",connected:true,status:"running",screen:null,capabilities:{actions:{}},state:{grbl:{tapProfile:{minimumTouchZ,maximumTouchZ}}}};}
test("physical taps reuse manual Normal inside this device's advertised range, without mutating calibration",()=>{
  const d=device(9.5,10);assert.deepEqual(normalTouchPressure(tap,d),{...tap,touchZ:9.825});assert.equal("touchZ" in tap,false);
  assert.deepEqual(normalTouchPressure(tap,device(3,4)),{...tap,touchZ:3.65});
  assert.deepEqual(normalTouchPressure(tap,device(4,3)),tap);
  assert.deepEqual(normalTouchPressure(tap,device(NaN,4)),tap);
  const explicit={...tap,touchZ:9.6};assert.equal(normalTouchPressure(explicit,d),explicit);
  const home:ScreenHandSemanticAction={type:"phone_key",key:"home"};assert.equal(normalTouchPressure(home,d),home);
});
test("swipes preserve continuous-contact driver pressure; long presses use Normal",()=>{
  const d=device(9.5,10);
  const swipe:ScreenHandSemanticAction={type:"swipe",start:{x:300,y:900},end:{x:300,y:400},viewport:{width:720,height:1560},frameSequence:1,durationMs:300};
  const press:ScreenHandSemanticAction={type:"long_press",point:{x:100,y:200},viewport:{width:720,height:1560},frameSequence:1,durationMs:800};
  assert.equal(normalTouchPressure(swipe,d),swipe);
  assert.equal((normalTouchPressure(press,d) as typeof press).touchZ,9.825);
  const explicit={...swipe,touchZ:9.7};assert.equal(normalTouchPressure(explicit,d),explicit);
});
test("short clicks do not inherit a deeper continuous-contact default",()=>{
  const d=device(9.5,10);d.state!.grbl!.tapProfile!.touchZ=10;
  assert.equal((normalTouchPressure(tap,d) as typeof tap).touchZ,9.825);
  d.state!.grbl!.tapProfile!.touchZ=12;assert.equal((normalTouchPressure(tap,d) as typeof tap).touchZ,9.825);
  d.state!.grbl!.tapProfile!.touchZ=NaN;assert.equal((normalTouchPressure(tap,d) as typeof tap).touchZ,9.825);
});
