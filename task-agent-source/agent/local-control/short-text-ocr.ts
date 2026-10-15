import {spawn} from 'node:child_process';
/** Local fallback for short field contents that Vision omitted. No expected
 * text or character whitelist is supplied to the recognizer. */
export async function readShortFieldEvidence(bytes:Buffer,signal:AbortSignal):Promise<{text:string;confidence:number;box?:{left:number;top:number;width:number;height:number}}> {
  const empty={text:"",confidence:0};
  const command=process.env.SCREENHAND_GLYPH_OCR_COMMAND;if(!command)return empty;
  try {
    const tsv=await new Promise<string>((resolve,reject)=>{
      const child=spawn(command,['stdin','stdout','--psm','7','tsv'],{signal:AbortSignal.any([signal,AbortSignal.timeout(900)]),stdio:['pipe','pipe','ignore'],env:{...process.env,OMP_THREAD_LIMIT:'1'}});
      let output='';child.stdout.on('data',b=>{output+=b.toString();if(output.length>20000){child.kill();reject(new Error('Field OCR output too large'));}});
      child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(new Error('Field OCR failed')));child.stdin.on('error',()=>{});child.stdin.end(bytes);
    });
    const words=tsv.split('\n').filter(l=>l.startsWith('5\t')).map(l=>l.split('\t'));
    if(!words.length||!words.every(c=>Number(c[10])>=85))return empty;
    const left=Math.min(...words.map(c=>Number(c[6]))),top=Math.min(...words.map(c=>Number(c[7]))),right=Math.max(...words.map(c=>Number(c[6])+Number(c[8]))),bottom=Math.max(...words.map(c=>Number(c[7])+Number(c[9])));
    return {text:words.map(c=>c.slice(11).join('\t').trim()).join(' '),confidence:Math.min(...words.map(c=>Number(c[10])))/100,box:{left,top,width:right-left,height:bottom-top}};
  }catch {signal.throwIfAborted();return empty;}
}

export async function readShortFieldText(bytes:Buffer,signal:AbortSignal){return (await readShortFieldEvidence(bytes,signal)).text;}
