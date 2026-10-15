import {spawn} from 'node:child_process';
import sharp from 'sharp';
import type {ScreenElement} from '../general-agent-contract';

/** Supplemental LOCAL sparse-symbol OCR. No app names, button coordinates or
 * arithmetic answers are encoded here. Scores stay the recognizer's scores. */
export function parseGlyphTsv(tsv:string,width:number,height:number):ScreenElement[]{
  return tsv.split('\n').slice(1).flatMap((line,i)=>{
    const c=line.split('\t');if(c[0]!=='5'||c.length<12)return [];
    const [left,top,w,h,score]=c.slice(6,11).map(Number),text=c.slice(11).join('\t').trim();
    if(![left,top,w,h,score].every(Number.isFinite)||left<0||top<height*.12||w<=0||h<=0||left+w>width||top+h>height||score<65||!text||text.length>80||!/^[-+−×÷=%.()0-9]+$/.test(text))return [];
    return [{id:`glyph-${i}`,role:'text' as const,text,confidence:score/100,center:{x:left+w/2,y:top+h/2},bounds:{left,top,width:w,height:h}}];
  });
}
export function mergeGlyphs(base:ScreenElement[],extra:ScreenElement[]){
  const merged=[...base];
  for(const e of extra){
    const overlaps=base.filter(b=>Math.abs(b.center.x-e.center.x)<Math.max(b.bounds.width,e.bounds.width)*.65&&Math.abs(b.center.y-e.center.y)<Math.max(b.bounds.height,e.bounds.height)*.65);
    if(!overlaps.length)merged.push(e);
    // Disagreement never overwrites an existing label or fabricates confidence.
  }
  return merged;
}
export async function supplementGlyphs(bytes:Buffer,elements:ScreenElement[],signal:AbortSignal){
  const command=process.env.SCREENHAND_GLYPH_OCR_COMMAND;
  if(!command||elements.filter(e=>e.confidence>=.9&&/^[0-9]$/.test(e.text)).length<6)return elements;
  const {data,info}=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const ink=Buffer.alloc(info.width*info.height);let dark=0;
  for(let i=0;i<ink.length;i++)if(Math.max(data[i*3],data[i*3+1],data[i*3+2])<80)dark++;
  // Neutral light glyphs on dark UI, or dark glyphs on light UI. Colored fills
  // are removed without guessing which application or operation they represent.
  for(let i=0;i<ink.length;i++){const min=Math.min(data[i*3],data[i*3+1],data[i*3+2]),max=Math.max(data[i*3],data[i*3+1],data[i*3+2]);ink[i]=(dark>ink.length*.5?min>150:max<100)?0:255;}
  const png=await sharp(ink,{raw:{width:info.width,height:info.height,channels:1}}).png().toBuffer();
  const tsv=await new Promise<string>((resolve,reject)=>{
    const child=spawn(command,['stdin','stdout','--psm','6','tsv'],{signal:AbortSignal.any([signal,AbortSignal.timeout(700)]),stdio:['pipe','pipe','ignore'],env:{...process.env,OMP_THREAD_LIMIT:'1'}});
    let output='';child.stdout.on('data',b=>{output+=b.toString();if(output.length>100000){child.kill();reject(new Error('Glyph OCR output exceeded limit'));}});
    child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(new Error('Local glyph OCR failed')));child.stdin.on('error',()=>{});child.stdin.end(png);
  });
  return mergeGlyphs(elements,parseGlyphTsv(tsv,info.width,info.height));
}
