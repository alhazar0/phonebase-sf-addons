import {z} from 'zod';
import {cameraRegionSchema,regionContains} from './interaction';
import type {LocalView} from './executor';
export const messageEffectSchema=z.object({targetId:z.string().regex(/^[tc]\d{1,2}$/),recipient:z.string().regex(/^\+?[0-9]{3,20}$/),body:z.string().min(1).max(120),recipientRegion:cameraRegionSchema,composerRegion:cameraRegionSchema,outgoingRegion:cameraRegionSchema}).strict();
export type MessageEffect=z.infer<typeof messageEffectSchema>;
export const messageSendRequested=(goal:string)=>/(发送|发给|给.+发|\bsend\b)/i.test(goal)&&!/(不发送|不发|不要发|别发|暂不发|勿发|do not send|don't send|draft only|仅.*草稿)/i.test(goal);
const fieldValueMatches=(actual:string,expected:string)=>/^\+?\d+$/.test(expected)?actual.replace(/^(?:To|收件人)\s*[:：]\s*/i,'').replace(/[\s()+-]/g,'')===expected.replace('+',''):actual.normalize('NFKC').trim()===expected.normalize('NFKC').trim();
const inRegion=(v:LocalView,r:MessageEffect['composerRegion'])=>v.elements.filter(e=>e.confidence>=.9&&regionContains(r,e,v));
export const messageTextVisible=(v:LocalView,r:MessageEffect['composerRegion'],text:string)=>inRegion(v,r).filter(e=>fieldValueMatches(e.text,text)).length===1;
export function validateMessageDraft(spec:MessageEffect,goal:string,views:LocalView[]){
  const requestedNumbers=goal.match(/\+?\d(?:[\s()-]*\d){2,19}/g)??[];
  if(!goal.includes(spec.body)||!requestedNumbers.some(n=>n.replace(/[\s()+-]/g,'')===spec.recipient.replace('+','')))throw new Error('Recipient and message must be literal values requested in the current task');
  if(!messageSendRequested(goal))throw new Error('This task does not authorize sending a message');
  const a=spec.composerRegion,b=spec.outgoingRegion;
  if(Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top))throw new Error('Outgoing bubble evidence must be separate from the draft composer');
  if(views.length!==2||views[1].frame.sequence<=views[0].frame.sequence||views[1].frame.capturedAt<=views[0].frame.capturedAt)throw new Error('Message preparation requires two independent current frames');
  for(const v of views){
    if(v.state.overlay!=='none'||v.timing.ocrCacheHit||v.timing.ocrCapturedAt!==v.frame.capturedAt)throw new Error('Message preparation requires fresh unobstructed OCR');
    if(!messageTextVisible(v,spec.recipientRegion,spec.recipient)||!messageTextVisible(v,spec.composerRegion,spec.body))throw new Error('Exact recipient and unsent message must both be visible in their bound regions');
    if(messageTextVisible(v,spec.outgoingRegion,spec.body))throw new Error('The same outgoing message already exists in the result region; no duplicate send');
  }
}
export function assessMessageResult(spec:MessageEffect,view:LocalView){
  const failed=view.elements.some(e=>e.confidence>=.65&&/not delivered|failed to send|发送失败|未送达/i.test(e.text));
  return {met:!failed&&view.state.overlay==='none'&&messageTextVisible(view,spec.outgoingRegion,spec.body)&&!messageTextVisible(view,spec.composerRegion,spec.body)&&messageTextVisible(view,spec.recipientRegion,spec.recipient),failed,deliveryVerified:false as const};
}
