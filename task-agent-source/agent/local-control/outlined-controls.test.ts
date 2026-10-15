import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {detectOutlinedControls} from './outlined-controls';
import {observedControls,observedKeyboardTop} from './interaction';
import type {LocalView} from './executor';

test('a closed low-contrast outline becomes a neutral component; parallel open rules do not',async()=>{
  const raster=async(shape:string)=>sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#bbb"/>${shape}</svg>`)).jpeg().toBuffer();
  const closed=await detectOutlinedControls(await raster('<rect x="180" y="710" width="360" height="42" rx="20" fill="none" stroke="#999" stroke-width="2"/>'),720,1280);
  assert.ok(closed.some(c=>Math.abs(c.center.x-360)<20&&Math.abs(c.center.y-731)<8));
  assert.ok(closed.every(c=>c.label.includes('unverified')));
  assert.deepEqual(await detectOutlinedControls(await raster('<path d="M180 710 H540 M180 752 H540" stroke="#999" stroke-width="2"/>'),720,1280),[]);
});

test('keyboard exclusion follows observed key rows and keeps a composer above the keys reachable',()=>{
  const view={frame:{width:720,height:1280},state:{keyboard:true},elements:[1,2,3].map((n,i)=>({text:String(n),confidence:1,center:{x:200+i*150,y:810},bounds:{left:190+i*150,top:800,width:20,height:24}})),affordances:[740,810].map(y=>({role:'control',confidence:.9,center:{x:360,y},bounds:{left:190,top:y-20,width:340,height:40}}))} as LocalView;
  assert.equal(observedKeyboardTop(view),785.6);
  assert.deepEqual(observedControls(view).map(c=>c.center.y),[740]);
});
