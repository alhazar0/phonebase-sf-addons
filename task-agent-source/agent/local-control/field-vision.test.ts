import test from 'node:test';import assert from 'node:assert/strict';import sharp from 'sharp';import {inspectFieldSnapshot} from './field-vision';import type {LocalView} from './executor';
const region={left:100,top:290,width:400,height:50},box={left:150,top:300,width:90,height:24};
async function fixture({muted=false,caret=0,selected=false,faint=false,partial=false}={}){
  const glyphs=Array.from({length:6},(_,i)=>`<rect x="${153+i*14}" y="303" width="4" height="20" fill="${muted?'#999':'#222'}"/>`).join('');
  const end=partial?195:241;
  const image=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#eee"/>${selected?`<rect x="149" y="297" width="${end-149}" height="30" fill="${faint?'#bbc2ce':'#63a5ec'}"/>`:''}${glyphs}${faint?`<circle cx="149" cy="295" r="6" fill="#1841dc"/><rect x="148" y="295" width="2" height="30" fill="#1841dc"/><circle cx="${end}" cy="329" r="6" fill="#1841dc"/><rect x="${end-1}" y="300" width="2" height="29" fill="#1841dc"/>`:''}${caret?`<rect x="${caret}" y="298" width="2" height="29" fill="#1841dc"/>`:''}<rect x="151" y="802" width="9" height="24" fill="#111"/></svg>`)).png().toBuffer();
  return {frame:{width:720,height:1280,sequence:1,capturedAt:1,image:`data:image/png;base64,${image.toString('base64')}`},elements:[{text:'a',confidence:1,center:{x:156,y:814},bounds:{left:150,top:800,width:15,height:28}}]} as LocalView;
}
test('field pixels distinguish muted placeholders, actual values, end/interior carets and full selection',async()=>{
  const placeholder=await inspectFieldSnapshot(await fixture({muted:true,caret:148}),region,'First name','First name',1,box);assert.equal(placeholder.kind,'placeholder');assert.equal(placeholder.value,'');
  const end=await inspectFieldSnapshot(await fixture({caret:240}),region,'hi','hi',1,box);assert.equal(end.kind,'value');assert.equal(end.value,'hi');assert.equal(end.caret,'end');assert.equal(end.selection,'none');
  const interior=await inspectFieldSnapshot(await fixture({caret:195}),region,'hi','hi',1,box);assert.equal(interior.caret,'inside');assert.notEqual(interior.selection,'all');
  const all=await inspectFieldSnapshot(await fixture({selected:true}),region,'hello','hello',1,box);assert.equal(all.selection,'all');assert.equal(all.kind,'value');
  const faint=await inspectFieldSnapshot(await fixture({selected:true,faint:true}),region,'hello','hello',1,box);assert.equal(faint.selection,'all');
  for(const faint of [false,true]){const partial=await inspectFieldSnapshot(await fixture({selected:true,partial:true,faint}),region,'hello','hello',1,box);assert.notEqual(partial.selection,'all');}
  const absent=await inspectFieldSnapshot(await fixture(),region,'First name','',0);assert.equal(absent.kind,'ambiguous');assert.equal(absent.value,null);
});
