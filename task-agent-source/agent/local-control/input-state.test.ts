import test from 'node:test';import assert from 'node:assert/strict';import {reconcileField,type FieldSnapshot} from './input-state';
const read=(value:string,seq:number,patch:Partial<FieldSnapshot>={}):FieldSnapshot=>({sequence:seq,capturedAt:seq,rawText:value,value,kind:'value',caret:'end',selection:'none',confidence:1,...patch});
const pair=(value:string,patch:Partial<FieldSnapshot>={})=>[read(value,1,patch),read(value,2,patch)];
test('desired state chooses no-op, suffix, focus, or replacement without treating a value as a placeholder',()=>{
  assert.equal(reconcileField('hi',pair('hi')).action,'done');
  const prefix=reconcileField('hi how are you',pair('hi'));assert.equal(prefix.action,'type_suffix');assert.equal(prefix.prefixLength,2);
  assert.equal(reconcileField('hi how are you',pair('hi',{caret:'inside'})).action,'focus_end');
  assert.equal(reconcileField('hi how are you',pair('hi hhi')).action,'select_all');
  assert.equal(reconcileField('hi how are you',pair('hi hhi',{selection:'all'})).action,'replace_selection');
  assert.equal(reconcileField('alex',[read('al',1),read('al',2,{caret:'absent'})]).action,'type_suffix');
  assert.equal(reconcileField('alex',pair('ale'),false,'alex').action,'select_all');
  assert.equal(reconcileField('alex',pair('',{kind:'placeholder',rawText:'First name'})).action,'type_suffix');
  assert.equal(reconcileField('alex',pair('',{kind:'placeholder',rawText:'First name',caret:'absent'})).action,'focus_end');
});
test('one frame, disagreement, ambiguous OCR, unconfirmed selection and uncertain receipts never authorize keys',()=>{
  assert.equal(reconcileField('hello',[read('he',1)]).action,'observe');
  assert.equal(reconcileField('hello',[read('he',1),read('he',1)]).action,'observe');
  assert.equal(reconcileField('hello',[read('he',1),read('hE',2)]).action,'observe');
  assert.equal(reconcileField('hello',pair('he',{kind:'ambiguous'})).action,'observe');
  assert.equal(reconcileField('hello',[read('wrong',1),read('wrong',2,{selection:'all'})]).action,'observe');
  assert.equal(reconcileField('hello',pair('hello'),true).action,'stop');
  assert.equal(reconcileField('hello',pair('he',{selection:'partial',caret:'end'})).action,'select_all');
  assert.equal(reconcileField('hi how',pair('',{rawText:'hi',kind:'placeholder'})).action,'observe');
});
