import sharp from 'sharp';
import type {LocalView} from './executor';
import type {FieldSnapshot} from './input-state';
export type PixelBox={left:number;top:number;width:number;height:number};
const quantile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]??0;
const labelNorm=(s:string)=>s.normalize('NFKC').trim().replace(/\s*([•·])\s*/g,'$1').replace(/^\|\s*/,'').replace(/(:)\s*\|$/,'$1').toLowerCase();
/** Observe glyph contrast, insertion caret and selection in a bound field.
 * These are geometry/style facts, not an app name or a predicted input value. */
export async function inspectFieldSnapshot(view:LocalView,region:PixelBox,label:string,rawText:string,confidence:number,textBox?:PixelBox):Promise<FieldSnapshot>{
  const base={sequence:view.frame.sequence,capturedAt:view.frame.capturedAt,rawText,confidence};
  const {data,info}=await sharp(Buffer.from(view.frame.image.split(',')[1],'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const rgb=(x:number,y:number)=>{const i=(Math.round(y)*info.width+Math.round(x))*3;return [data[i],data[i+1],data[i+2]];};
  const pixels=(b:PixelBox)=>{const out:number[][]=[];for(let y=Math.max(0,Math.ceil(b.top));y<Math.min(info.height,b.top+b.height);y++)for(let x=Math.max(0,Math.ceil(b.left));x<Math.min(info.width,b.left+b.width);x++)out.push(rgb(x,y));return out;};
  const lum=(p:number[])=>p[0]*.21+p[1]*.72+p[2]*.07;
  const blue=(p:number[])=>p[2]>p[0]+24&&p[2]>p[1]+6&&p[2]>70;
  const cyan=(p:number[])=>blue(p)||p[1]>p[0]+18&&p[2]>p[0]+18;
  const bg=quantile(pixels(region).map(lum),.5);
  const contrast=(box:PixelBox,background:number)=>{
    const values=pixels(box).filter(p=>!cyan(p)).map(p=>Math.abs(lum(p)-background)).filter(n=>n>12);
    return values.length>8?quantile(values,.65):0;
  };
  const box=textBox??region;
  const keyContrasts=view.elements.filter(e=>e.confidence>=.65&&/^[a-z]$/i.test(e.text)&&e.center.y>region.top+region.height&&e.center.y>view.frame.height*.5).map(e=>{
    const background=quantile(pixels({left:e.bounds.left-4,top:e.bounds.top-5,width:e.bounds.width+8,height:e.bounds.height+10}).map(lum),.6);return contrast(e.bounds,background);
  }).filter(n=>n>40);
  const reference=quantile(keyContrasts,.5),ink=contrast(box,bg);
  const muted=reference>60&&ink>12&&ink<reference*.72;
  const columns:Array<{x:number;top:number;bottom:number;count:number}>=[];
  for(let x=Math.ceil(region.left);x<region.left+region.width;x++){
    const ys:number[]=[];for(let y=Math.ceil(region.top);y<region.top+region.height;y++)if(blue(rgb(x,y)))ys.push(y);
    if(ys.length>=Math.max(10,box.height*.65)&&ys.length/(ys.at(-1)!-ys[0]+1)>.75)columns.push({x,top:ys[0],bottom:ys.at(-1)!,count:ys.length});
  }
  const groups:Array<typeof columns>=[];for(const c of columns){const last=groups.at(-1);if(last&&c.x-last.at(-1)!.x<=2)last.push(c);else groups.push([c]);}
  const carets=groups.filter(g=>g.at(-1)!.x-g[0].x+1<=Math.max(4,region.height*.13)&&Math.max(...g.map(c=>c.bottom-c.top))>=box.height*.8);
  const caretX=carets.length===1?(carets[0][0].x+carets[0].at(-1)!.x)/2:null;
  let selectedPixels=0,totalPixels=0;const selectedColumns=new Map<number,number>();
  for(let y=Math.max(0,Math.ceil(box.top));y<Math.min(info.height,box.top+box.height);y++)for(let x=Math.max(0,Math.ceil(box.left));x<Math.min(info.width,box.left+box.width);x++){
    totalPixels++;if((caretX===null||Math.abs(x-caretX)>3)&&cyan(rgb(x,y))){selectedPixels++;selectedColumns.set(x,(selectedColumns.get(x)??0)+1);}
  }
  const selected=selectedPixels/Math.max(1,totalPixels);
  // iOS can render selection fill very faintly. Two separate strong blue drag
  // handles spanning the text prove the range even when the fill is muted.
  const rw=Math.ceil(region.width),rh=Math.ceil(region.height),mask=new Uint8Array(rw*rh),components:PixelBox[]=[];
  for(let y=0;y<rh;y++)for(let x=0;x<rw;x++)if(blue(rgb(region.left+x,region.top+y)))mask[y*rw+x]=1;
  for(let seed=0;seed<mask.length;seed++){
    if(!mask[seed])continue;const q=[seed];mask[seed]=0;let left=rw,right=0,top=rh,bottom=0;
    for(let i=0;i<q.length;i++){const p=q[i],x=p%rw,y=Math.floor(p/rw);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);for(const n of [x?p-1:-1,x<rw-1?p+1:-1,y?p-rw:-1,y<rh-1?p+rw:-1])if(n>=0&&mask[n]){mask[n]=0;q.push(n);}}
    if(right-left>=box.height*.25&&bottom-top>=box.height*.5&&q.length>=box.height*box.height*.08)components.push({left:region.left+left,top:region.top+top,width:right-left+1,height:bottom-top+1});
  }
  const handles=components.some((a,i)=>Math.abs(a.left+a.width/2-box.left)<box.height*.7&&a.top<box.top&&components.some((b,j)=>i!==j&&Math.abs(b.left+b.width/2-(box.left+box.width))<box.height*.7&&b.top+b.height>box.top+box.height));
  const coverage=selectedColumns.size/Math.max(1,box.width);
  const selection:FieldSnapshot['selection']=handles||selected>.38&&coverage>.85?'all':selected>.10?'partial':'none';
  let kind:FieldSnapshot['kind']='value',value:string|null=rawText.normalize('NFKC').trim();
  if(!rawText||confidence<.65){kind='ambiguous';value=null;}
  else if(/[:：]$/.test(label)&&labelNorm(rawText).startsWith(labelNorm(label))){value=rawText.slice(label.length).trim();}
  else if(labelNorm(rawText)===labelNorm(label)&&muted&&selection==='none'){kind='placeholder';value='';}
  else if(/^Q\s/.test(label)&&/^Q\s/.test(value))value=value.slice(2).trim();
  const caret:FieldSnapshot['caret']=caretX===null?'absent':value===''?'end':caretX>=box.left+box.width-Math.max(5,box.height*.35)?'end':'inside';
  return {...base,value,kind,caret,selection};
}
