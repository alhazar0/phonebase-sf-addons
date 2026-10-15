import sharp from 'sharp';import type {VisualAffordance} from '../visual-affordance-detector';
/** Current colored connected components, no fixed UI positions or action names. */
export async function detectColoredControls(bytes:Buffer,width:number,height:number):Promise<VisualAffordance[]>{
  const w=Math.min(width,360),h=Math.round(height*w/width),scale=width/w;
  const data=await sharp(bytes).resize(w,h).removeAlpha().raw().toBuffer();const mask=new Uint8Array(w*h);
  for(let i=0;i<mask.length;i++){const r=data[i*3],g=data[i*3+1],b=data[i*3+2];if(Math.max(r,g,b)<85||Math.max(r,g,b)-Math.min(r,g,b)<32)continue;
    if(!(b>r+12&&b>g+3||g>r+20&&g>b+8||r>g+30&&r>b+20))continue;
    const x=i%w,y=Math.floor(i/w);for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h)mask[(y+dy)*w+x+dx]=1;
  }
  const out:VisualAffordance[]=[],queue=new Int32Array(w*h);
  for(let seed=0;seed<mask.length;seed++){if(mask[seed]!==1)continue;let head=0,tail=1,left=w,right=0,top=h,bottom=0;queue[0]=seed;mask[seed]=2;
    while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(const j of [x?i-1:-1,x<w-1?i+1:-1,y?i-w:-1,y<h-1?i+w:-1])if(j>=0&&mask[j]===1){mask[j]=2;queue[tail++]=j;}}
    const bw=(right-left+1)*scale,bh=(bottom-top+1)*scale;if(top/h<.115||bw<14||bh<14||bw>width*.14||bh>height*.1||bw/bh<.45||bw/bh>2.2||tail<20)continue;
    const bounds={left:left*scale,top:top*scale,width:bw,height:bh};
    out.push({role:'control',label:'colored visual component (function unverified)',confidence:.9,center:{x:bounds.left+bw/2,y:bounds.top+bh/2},bounds,source:'local_intensity',edgeDensity:tail/((right-left+1)*(bottom-top+1)),localContrast:32});
  }
  return out;
}
