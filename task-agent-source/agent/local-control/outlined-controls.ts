import sharp from 'sharp';
import type {VisualAffordance} from '../visual-affordance-detector';
/** Detect closed wide outlines from current pixels. A shape is not a promise
 * that it is editable; the planner must focus and inspect it before input. */
export async function detectOutlinedControls(bytes:Buffer,width:number,height:number):Promise<VisualAffordance[]> {
  const w=Math.min(width,360),h=Math.round(height*w/width),scale=width/w;
  const data=await sharp(bytes).resize(w,h).grayscale().blur(.6).raw().toBuffer();
  const lines:Array<{x:number;y:number;right:number;support:number}>=[];
  for(let y=Math.ceil(h*.12);y<h-5;y++) {
    let start=-1,last=-1,hits=0;
    for(let x=5;x<w-5;x++) {
      const i=y*w+x,score=(data[i-3*w]+data[i+3*w])/2-data[i];
      if(score>=1.8){if(start<0)start=x;last=x;hits++;}
      if(start>=0&&(x-last>8||x===w-6)){
        if(last-start>=w*.2&&hits/(last-start+1)>.75)lines.push({x:start,y,right:last,support:hits/(last-start+1)});
        start=-1;hits=0;
      }
    }
  }
  const out:VisualAffordance[]=[];
  for(const a of lines)for(const b of lines){
    const dy=b.y-a.y,bw=Math.min(a.right,b.right)-Math.max(a.x,b.x);
    if(dy<10||dy>h*.065||bw/dy<3||bw/dy>16||Math.abs(a.x-b.x)>dy*.5||Math.abs(a.right-b.right)>dy*.5)continue;
    const cy=Math.round((a.y+b.y)/2);
    const side=(edge:number)=>{let best=-1,bestScore=0;for(let x=Math.round(edge-dy*.6);x<=edge+dy*.6;x++){
      if(x<4||x>=w-4)continue;let count=0;
      for(let y=cy-3;y<=cy+3;y++){const i=y*w+x;if((data[i-3]+data[i+3])/2-data[i]>=1.8)count++;}
      if(count>bestScore){bestScore=count;best=x;}
    }return bestScore>=5?best:-1;};
    const left=side(Math.min(a.x,b.x)),right=side(Math.max(a.right,b.right));
    if(left<0||right<0||right-left<bw*.9)continue;
    if(out.some(o=>Math.abs(o.center.y-cy*scale)<dy*scale*.5&&Math.abs(o.center.x-(left+right)*scale/2)<bw*scale*.3))continue;
    const bounds={left:left*scale,top:a.y*scale,width:(right-left)*scale,height:dy*scale};
    out.push({role:'control',label:'wide closed outline (function unverified)',confidence:.85,center:{x:(left+right)*scale/2,y:cy*scale},bounds,source:'local_edges',edgeDensity:Math.min(a.support,b.support),localContrast:1.8});
  }
  return out.slice(0,24);
}
