/** Desired-state reconciliation. OCR is evidence about a field, never an
 * instruction to append. All write decisions require two independent reads. */
export type FieldSnapshot={sequence:number;capturedAt:number;rawText:string;value:string|null;kind:'placeholder'|'value'|'ambiguous';caret:'end'|'inside'|'absent';selection:'all'|'partial'|'none';confidence:number};
export type InputResolution={state:'unreadable'|'empty'|'exact'|'prefix'|'different'|'uncertain';action:'observe'|'done'|'type_suffix'|'focus_end'|'select_all'|'replace_selection'|'stop';currentValue:string|null;prefixLength:number;reason:string};
export function reconcileField(desired:string,reads:FieldSnapshot[],uncertainSubmission=false,submittedPrefix?:string):InputResolution {
  const result=(state:InputResolution['state'],action:InputResolution['action'],currentValue:string|null,reason:string):InputResolution=>({state,action,currentValue,prefixLength:currentValue&&desired.startsWith(currentValue)?currentValue.length:0,reason});
  if(uncertainSubmission)return result('uncertain','stop',null,'A submitted action has no confirmed receipt; never replay it');
  const [a,b]=reads.slice(-2);
  if(!a||!b||b.sequence<=a.sequence||b.capturedAt<=a.capturedAt||a.confidence<.65||b.confidence<.65||a.kind==='ambiguous'||b.kind==='ambiguous'||a.value===null||b.value===null||a.value!==b.value||a.kind!==b.kind)return result('unreadable','observe',null,'Need two independent, agreeing field reads');
  const value=b.value;
  // A caret omitted in the next otherwise identical frame is blinking, not
  // evidence that insertion moved. A positively observed interior caret wins.
  const end=b.caret==='end'||b.caret==='absent'&&a.caret==='end'&&b.selection==='none'&&b.capturedAt-a.capturedAt<1500;
  if(b.kind==='placeholder'&&b.rawText.trim()&&desired.toLowerCase().startsWith(b.rawText.trim().toLowerCase()))return result('unreadable','observe',null,'Placeholder appearance conflicts with an existing requested-value prefix');
  if(value===desired)return result('exact','done',value,'Desired value already exists; no focus or keys needed');
  if(b.selection==='all'&&a.selection!=='all')return result('unreadable','observe',value,'Confirm the full selection in another frame');
  if(b.selection==='all')return result(value?'different':'empty','replace_selection',value,'Existing field text is selected; replace once, then verify');
  if(b.selection==='partial')return result('different','select_all',value,'A partial selection cannot authorize suffix typing; select the entire field before replacement');
  if(submittedPrefix&&desired.startsWith(value)&&submittedPrefix.startsWith(value)&&value.length<submittedPrefix.length)return result('different','select_all',value,'Observed value trails completed key submissions; never replay a suffix that may already exist. Select and replace the field to reconcile it');
  if(!value)return result('empty',end?'type_suffix':'focus_end','','Empty field is independently established');
  if(desired.startsWith(value))return result('prefix',end?'type_suffix':'focus_end',value,'Continue only after the exact existing prefix, with caret at its end');
  return result('different','select_all',value,'Current content differs; append is forbidden, select the field contents before replacement');
}
