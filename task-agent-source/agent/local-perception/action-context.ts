export type RecentAction={id:string;action:string;status:"accepted"|"executing"|"completed"|"failed";at:number;visualVerified:false};

/** Existing control-plane receipts are motor evidence, never proof of UI success.
 * Whitelist metadata: no typed messages, coordinates, result bodies or actors. */
export function actionContextReader(base:string,fetcher:typeof fetch=fetch) {
  const url=new URL(base);
  if(url.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(url.hostname)||url.username||url.password)throw new Error("Action context must be local");
  return async(deviceId:string,signal:AbortSignal):Promise<RecentAction[]>=>{
    if(!/^[a-zA-Z0-9._-]{1,120}$/.test(deviceId))throw new Error("Invalid device ID");
    const response=await fetcher(new URL(`/api/v1/devices/${encodeURIComponent(deviceId)}/actions`,url),{
      method:"GET",redirect:"error",cache:"no-store",signal:AbortSignal.any([signal,AbortSignal.timeout(500)])});
    if(!response.ok)throw new Error("Action history unavailable");
    const reader=response.body?.getReader();if(!reader)throw new Error("Action history unavailable");
    const parts:Uint8Array[]=[];let size=0;
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1_000_000)throw new Error("Action history exceeds limit");parts.push(part.value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const body=JSON.parse(Buffer.concat(parts).toString("utf8"));
    if(!Array.isArray(body.receipts))throw new Error("Invalid action history");
    return body.receipts.filter((r:Record<string,unknown>)=>r.deviceId===deviceId&&typeof r.id==="string"&&/^action-[a-zA-Z0-9-]{1,80}$/.test(r.id)&&
      ["tap","swipe","phone_key","input_text"].includes(String(r.actionType))&&["accepted","executing","completed","failed"].includes(String(r.status))&&
      Number.isSafeInteger(r.updatedAt)&&Date.now()-Number(r.updatedAt)<=30_000&&Number(r.updatedAt)<=Date.now())
      .sort((a:{updatedAt:number},b:{updatedAt:number})=>b.updatedAt-a.updatedAt).slice(0,6)
      .map((r:{id:string;actionType:string;status:RecentAction["status"];updatedAt:number})=>({id:r.id,action:r.actionType,status:r.status,at:r.updatedAt,visualVerified:false}));
  };
}
