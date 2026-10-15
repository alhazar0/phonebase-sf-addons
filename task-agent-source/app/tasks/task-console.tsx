"use client";
/* eslint-disable @next/next/no-img-element -- Live camera JPEGs must not enter an image optimization cache. */

import {useCallback,useEffect,useRef,useState} from "react";
import Link from "next/link";
import type {ConsoleRun,RunInput} from "../../agent/task-console/manager";
import type {ConsoleDevice} from "../../agent/task-console/http";
import "./tasks.css";
const API="/task-console-api";
type Health={model:string;plannerConfigured:boolean;visibleTextEntry:boolean};
type Report={status?:string;phase?:string;error?:string;modelCalls?:number;timing?:Record<string,number>;
  decisions?:Array<{sourceSequence:number;elapsedMs:number;error?:string;decision?:{reason:string;kind:string;step?:{operation:string;text?:string|null}|null}}>;
  submissions?:Array<{key:string;state:string;receiptId?:string;elapsedMs:number;action:{type:string;key?:string;point?:{x:number;y:number};start?:{x:number;y:number};end?:{x:number;y:number}}}>;
  steps?:Array<{status:string;error?:string}>;objectives?:Array<{description:string;verified?:unknown}>;};
type Detail={run:ConsoleRun;report:Report|null;output:string};
const running=(r?:ConsoleRun|null)=>!!r&&["running","stopping"].includes(r.status);
const stateName:Record<string,string>={running:"执行中",stopping:"正在停止",finished:"已结束",stopped:"已停止",failed:"未完成",interrupted:"需要检查",observed_complete:"视觉验证成功",preview:"预览完成 · 未发动作",blocked:"受阻",budget_exhausted:"达到执行上限",action_uncertain:"动作结果不明",failed_runtime:"执行失败"};
const phases:Record<string,string>={observing:"观察当前画面",planning:"模型选择下一步",revalidating:"重新核对目标",acting:"执行并验证动作",finished:"任务已结束"};
const seconds=(value?:number)=>`${((value??0)/1000).toFixed(2)} s`;
const statusLabel=(run:ConsoleRun)=>running(run)||["stopped","interrupted"].includes(run.status)?stateName[run.status]:stateName[run.resultStatus??""]??stateName[run.status]??run.status;
class ApiError extends Error{constructor(readonly status:number,message:string){super(message);}}
async function request<T>(path:string,init?:RequestInit):Promise<T>{
  const response=await fetch(`${API}${path}`,{cache:"no-store",...init,headers:{...(init?.body?{"Content-Type":"application/json"}:{}),...init?.headers},signal:AbortSignal.timeout(7000)});
  const data=await response.json();if(!response.ok||!data.ok)throw new ApiError(response.status,data.error??`任务服务返回 ${response.status}`);return data as T;
}
export function TaskConsole(){
  const [health,setHealth]=useState<Health|null>(null),[devices,setDevices]=useState<ConsoleDevice[]>([]),[runs,setRuns]=useState<ConsoleRun[]>([]);
  const [deviceId,setDeviceId]=useState(""),[goal,setGoal]=useState(""),[selected,setSelected]=useState(""),[loadedDetail,setDetail]=useState<Detail|null>(null);
  const detail=loadedDetail?.run.id===selected?loadedDetail:null;
  const [error,setError]=useState(""),[submitting,setSubmitting]=useState(false),[stopPending,setStopPending]=useState(false),[note,setNote]=useState(""),[notePending,setNotePending]=useState(false);
  const [frameTick,setFrameTick]=useState(0),[frameError,setFrameError]=useState(false),[uncertain,setUncertain]=useState<RunInput|null>(null);
  const pending=useRef(false);
  const refresh=useCallback(async()=>{
    const [h,d,r]=await Promise.all([request<Health>("/health"),request<{devices:ConsoleDevice[]}>("/devices"),request<{runs:ConsoleRun[]}>("/runs")]);
    setHealth(h);setDevices(d.devices);setRuns(r.runs);
    setDeviceId(current=>current||d.devices.find(x=>x.connected)?.id||d.devices[0]?.id||"");
    setSelected(current=>current||r.runs.find(running)?.id||r.runs[0]?.id||"");
  },[]);
  useEffect(()=>{
    let disposed=false,inFlight=false;
    const poll=async()=>{if(inFlight)return;inFlight=true;try{await refresh();if(!disposed)setError(current=>current.startsWith("连接中断：")?"":current);}catch(e){if(!disposed){setHealth(null);setError(`连接中断：${(e as Error).message}`);}}finally{inFlight=false;}};
    void poll();const timer=setInterval(()=>void poll(),1500);return()=>{disposed=true;clearInterval(timer);};
  },[refresh]);
  useEffect(()=>{
    if(!selected)return;let disposed=false,inFlight=false;
    const poll=async()=>{if(inFlight)return;inFlight=true;try{const d=await request<Detail>(`/runs/${selected}`);if(!disposed)setDetail(d);}catch(e){if(!disposed)setError((e as Error).message);}finally{inFlight=false;}};
    void poll();const timer=setInterval(()=>void poll(),650);return()=>{disposed=true;clearInterval(timer);};
  },[selected]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)setFrameTick(Date.now());},1000);return()=>clearInterval(timer);},[deviceId]);
  const activeRun=runs.find(running),device=devices.find(d=>d.id===deviceId),blockedByReview=runs.some(r=>r.deviceId===deviceId&&r.needsReview);
  const canSubmit=!!health?.plannerConfigured&&!!device?.connected&&!activeRun&&!submitting&&!uncertain;
  const attach=async(id:string)=>{const d=await request<Detail>(`/runs/${id}`);setSelected(id);setDetail(d);setUncertain(null);await refresh();};
  const submit=async(mode:"execute"|"preview")=>{
    if(pending.current||!canSubmit||!goal.trim()||(mode==="execute"&&(!device?.ready||blockedByReview)))return;
    pending.current=true;setSubmitting(true);setError("");const input:RunInput={id:crypto.randomUUID(),deviceId,goal:goal.trim(),mode};
    try{await request("/runs",{method:"POST",body:JSON.stringify(input)});setSelected(input.id);await refresh();}
    catch(e){
      if(e instanceof ApiError&&e.status>=400&&e.status<500){setError(e.message);return;}
      // The POST may have been accepted before the network failed. Recover by
      // its SAME ID with a GET; never silently generate a second robot task.
      try{await attach(input.id);}catch{setUncertain(input);setError(`提交结果尚未确认：${(e as Error).message}。请先重新查询，不要重复执行。`);}
    }finally{pending.current=false;setSubmitting(false);}
  };
  const stop=async()=>{const id=activeRun?.id;if(!id||stopPending)return;setStopPending(true);try{await request(`/runs/${id}/stop`,{method:"POST",body:"{}"});await refresh();}catch(e){setError(`停止请求未确认：${(e as Error).message}，请再次点击停止并检查手机。`);}finally{setStopPending(false);}};
  const record=async()=>{if(!note.trim()||!selected||notePending)return;setNotePending(true);try{await request(`/runs/${selected}/notes`,{method:"POST",body:JSON.stringify({text:note})});setNote("");await attach(selected);}catch(e){setError((e as Error).message);}finally{setNotePending(false);}};
  const r=detail?.report,live=running(detail?.run),elapsed=live?Math.max(0,frameTick-Date.parse(detail!.run.createdAt)):r?.timing?.totalMs;
  return <main className="task-console">
    <header className="task-console-header"><div><Link href="/">← 人工控制</Link><h1>给手机一个任务</h1><p>你下达目标，系统自主执行。过程、耗时和问题都会留在本机。</p></div><div className={`task-service ${health?"online":""}`}><i/>{health?"任务服务在线":"正在连接任务服务"}<small>{health?.model??"本地执行器"}</small></div></header>
    <div className="task-console-grid">
      <section className="task-card task-compose" aria-label="提交手机任务">
        <div className="task-card-heading"><h2>新任务</h2><a href="/perception">查看识别 →</a></div>
        <label htmlFor="task-device">测试设备</label><select id="task-device" value={deviceId} disabled={!!activeRun||submitting} onChange={e=>setDeviceId(e.target.value)}><option value="" disabled>选择设备</option>{devices.map(d=><option key={d.id} value={d.id}>{d.id} · {d.connected?d.ready?"就绪":"已连接":"离线"}</option>)}</select>
        <form onSubmit={e=>{e.preventDefault();void submit("execute");}}>
          <label htmlFor="task-goal">你想让它做什么？</label><textarea id="task-goal" value={goal} onChange={e=>setGoal(e.target.value)} maxLength={1000} rows={5} placeholder="例如：返回主页，然后打开设置" onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault();void submit("execute");}}}/>
          <div className="task-input-hint"><span>⌘ / Ctrl + Enter 执行</span><span>{goal.length}/1000</span></div>
          <div className="task-submit-row"><button className="task-primary" disabled={!canSubmit||!goal.trim()||!device?.ready||blockedByReview}>{submitting?"正在提交…":"立即执行"}</button><button type="button" disabled={!canSubmit||!goal.trim()} onClick={()=>void submit("preview")}>仅预览</button></div>
        </form>
        <p className="task-help">执行会移动机械臂，无需我转发任务。预览只询问模型，不发送动作。</p>
        {activeRun?<div className="task-active"><strong>{activeRun.status==="stopping"?"正在停止后续动作":"有任务正在执行"}</strong><span>{activeRun.goal}</span><button type="button" className="task-stop" onClick={()=>void stop()} disabled={stopPending}>{stopPending?"正在请求…":"停止任务"}</button><small>停止后不再下发新动作；已下发的物理动作可能仍会完成。</small></div>:null}
        {!device?.ready&&device?.reason?<p className="task-warning">{device.reason}</p>:null}
        {!health?.plannerConfigured&&health?<p className="task-warning">尚未配置模型连接，不能开始任务。</p>:null}
        {blockedByReview?<p className="task-warning">此设备有结果不明的动作。请先检查对应任务日志，不能直接重试。</p>:null}
        <p className="task-warning">实验版本：触屏命中仍在排查；文字输入尚未实机验收，相关任务可能受阻。入口可用不代表任何任务都能完成。</p>
        <div className="task-camera"><div><strong>实时摄像头</strong><span>{deviceId||"未选择设备"}</span></div>{device?.connected?<><img src={`${API}/devices/${encodeURIComponent(deviceId)}/frame?t=${frameTick}`} alt="测试手机的实时摄像头画面" onLoad={()=>setFrameError(false)} onError={()=>setFrameError(true)}/>{frameError?<p>暂未收到画面，正在重新获取。</p>:null}</>:<p>连接设备后显示画面。</p>}</div>
      </section>
      <section className="task-card task-detail" aria-label="任务执行日志">
        <div className="task-card-heading"><h2>执行记录</h2>{detail?<a href={`${API}/runs/${detail.run.id}/report`} download>下载完整日志 ↗</a>:null}</div>
        {error?<div className="task-error" role="alert">{error}{uncertain?<button type="button" onClick={()=>void attach(uncertain.id).then(()=>setError("")).catch(e=>setError((e as Error).message))}>重新查询这次提交</button>:null}</div>:null}
        {detail?<>
          <div className="task-result-heading"><span className={`task-badge ${detail.run.status}`}>{statusLabel(detail.run)}</span><span>{live?(phases[r?.phase??""]??"启动执行器"):new Date(detail.run.createdAt).toLocaleString()}</span></div>
          <h3>{detail.run.goal}</h3><code className="task-run-id">任务编号 {detail.run.id}</code>
          {detail.run.error||r?.error?<p className="task-error">{detail.run.error||r?.error}</p>:null}
          <div className="task-metrics">{[["总耗时",seconds(elapsed)],["模型决策",seconds(r?.timing?.planningMs)],["机械动作",seconds(r?.timing?.actionMs)],["验证",seconds(r?.timing?.verificationMs)]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
          <p className="task-help">{r?.modelCalls??0} 次模型调用 · {r?.submissions?.length??0} 次动作提交。总耗时包含取图、决策、动作、验证和日志开销。</p>
          {!!r?.objectives?.length&&<ul className="task-objectives">{r.objectives.map((o,i)=><li key={i}>{o.verified?"✓":"○"} {o.description}</li>)}</ul>}
          <h4>每次决策</h4><ol className="task-decisions">{(r?.decisions??[]).map((d,i)=><li key={i}><div><strong>决策 {i+1} · {d.decision?.step?.operation??d.decision?.kind??"等待返回"}</strong><span>{seconds(d.elapsedMs)} · 帧 #{d.sourceSequence}</span></div><p>{d.error??d.decision?.reason??"正在根据当前画面决定下一步…"}</p>{d.decision?.step?.text&&<code>{d.decision.step.text}</code>}</li>)}</ol>
          <h4>实际动作与坐标</h4><div className="task-table-wrap"><table><thead><tr><th>动作</th><th>逻辑屏幕坐标</th><th>耗时</th><th>回执</th></tr></thead><tbody>{(r?.submissions??[]).map((s,i)=>{const p=s.action.point,a=s.action.start,b=s.action.end;return <tr key={s.key}><td>{i+1}. {s.action.type}{s.action.key?` / ${s.action.key}`:""}</td><td>{p?`(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`:a&&b?`(${a.x.toFixed(1)}, ${a.y.toFixed(1)}) → (${b.x.toFixed(1)}, ${b.y.toFixed(1)})`:"设备标定动作"}</td><td>{seconds(s.elapsedMs)}</td><td title={s.receiptId}>{s.state}</td></tr>;})}</tbody></table></div>
          {(r?.steps??[]).filter(s=>s.error).map((s,i)=><p className="task-warning" key={i}>{s.status}: {s.error}</p>)}
          <h4>问题记录</h4>{detail.run.notes.length?<ul className="task-notes">{detail.run.notes.map((n,i)=><li key={i}><time>{new Date(n.at).toLocaleTimeString()}</time> {n.text}</li>)}</ul>:<p className="task-help">异常结束会自动留档；你也可以补充刚才看到的问题。</p>}
          <form className="task-note-form" onSubmit={e=>{e.preventDefault();void record();}}><input aria-label="补充问题描述" value={note} maxLength={2000} onChange={e=>setNote(e.target.value)} placeholder="例如：机械臂移动了，但没有碰到按钮"/><button disabled={!note.trim()||notePending}>{notePending?"保存中…":"记录问题"}</button></form>
          <details className="task-raw"><summary>查看原始进程日志</summary><pre>{detail.output||"暂无输出"}</pre></details>
        </>:<div className="task-empty"><h3>从一条任务开始</h3><p>提交后立即显示执行过程。任务历史保存在电脑上，刷新页面不会重新执行。</p></div>}
      </section>
      <section className="task-card task-history"><div className="task-card-heading"><h2>历史任务</h2><small>{runs.length} 条 · 本机持久保存</small></div>{runs.length?<div className="task-history-list">{runs.map(run=><button type="button" className={selected===run.id?"selected":""} key={run.id} onClick={()=>{setSelected(run.id);setNote("");}}><div><strong>{run.goal}</strong><span>{statusLabel(run)}</span></div><small>{new Date(run.createdAt).toLocaleString()} · {run.deviceId} · {run.mode==="preview"?"预览":"实机"}</small></button>)}</div>:<p className="task-help">还没有通过这个入口提交的任务。</p>}</section>
    </div>
  </main>;
}
