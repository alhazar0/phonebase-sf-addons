"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { PerceptionSnapshot } from "../../agent/local-perception/service";
import type { PageKind } from "../../agent/local-perception/state";
import type { SemanticStatus,TextDocument } from "../../agent/local-perception/text-semantics";
import styles from "./perception.module.css";

const labels: Record<PageKind, string> = {
  unknown: "尚不能确定", screen_off: "息屏或遮挡", home: "应用主屏幕", clock: "世界时钟",
  search: "搜索界面", content_feed: "内容流", conversation: "对话界面", conversation_list: "会话列表",
  profile: "个人主页", settings: "设置界面",
};
const overlayLabels = { none: "无明确覆盖层", comments: "评论面板", dialog: "弹窗 / 对话框" };
const ms = (value: number | null | undefined) => value == null ? "—" : `${Math.round(value)} ms`;
type Device = { id: string; connected: boolean; status: string };
type History = { at: number; sequence: number; page: string; overlay: string };
type DisplaySnapshot = PerceptionSnapshot & { semantic?: SemanticStatus;scene?:TextDocument };
const layoutLabels = {vertical_list:"纵向列表",grid:"网格",conversation:"对话",content:"内容页",form:"表单",dialog:"对话框",unknown:"结构未知"};
const semanticLabels: Record<SemanticStatus["status"],string>={disabled:"文字辅助未启用",idle:"本地观察中，不自动请求模型",stale:"当前证据已变化，旧判断已隐藏；不会自动再请求",local_sufficient:"本地证据已足够，无需调用模型",insufficient_text:"新鲜文字证据不足",pending:"正在处理一次文字请求，画面继续更新",ready:"当前文字与判断依据匹配",cooldown:"请求正在处理或间隔不足，本次未新增调用",error:"辅助判断失败，不自动重试",budget_exhausted:"本次服务的请求限额已达，已停止请求"};
const callReasons={manual_initial:"主动请求页面解释",manual_evidence_changed:"主动请求解释变化后的页面",manual_retry:"主动重试失败的解释"};
const callOutcomes={pending:"处理中",validated:"文字结果校验通过（不是动作成功）",failed:"失败",cancelled:"已取消"};

export function PerceptionPanel() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const requestController=useRef<AbortController|null>(null);
  const [semanticNotice,setSemanticNotice]=useState<{deviceId:string;message:string}|null>(null);
  const [running, setRunning] = useState(true);
  const [visible, setVisible] = useState(true);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showIcons, setShowIcons] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<History[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState(0);

  function selectDevice(id: string) {
    setDeviceId(id); setSnapshot(null); setHistory([]); setSelectedId(null); setError("");
  }

  useEffect(()=>()=>requestController.current?.abort(),[deviceId]);

  async function requestExplanation() {
    if(requestController.current || !live || semantic?.pendingRequestId)return;
    const controller=new AbortController();requestController.current=controller;setSubmitting(true);
    const selectedDevice=deviceId;
    try {
      const response=await fetch("/local-perception-api/semantics",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({deviceId:selectedDevice,requestId:crypto.randomUUID()}),
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(6000)]),cache:"no-store"});
      const body=await response.json();
      if(!response.ok||!body.ok)throw new Error(body.error??"无法提交文字解释");
      if(!controller.signal.aborted)setSemanticNotice({deviceId:selectedDevice,message:body.semantic.status==="pending"?"已提交一次解释请求，完成情况以下方调用记录为准":semanticLabels[(body.semantic as SemanticStatus).status]});
      // Results are displayed only by the ordinary fresh-frame observation loop.
      // A late POST response must not attach an old judgment to a new image.
    } catch(e) {
      if(!controller.signal.aborted)setSemanticNotice({deviceId:selectedDevice,message:`${e instanceof Error?e.message:"请求状态不确定"}。不会自动重发，请查看调用记录。`});
    } finally {
      if(requestController.current===controller){requestController.current=null;setSubmitting(false);}
    }
  }

  useEffect(() => {
    const tick = setInterval(() => setClock(Date.now()), 250);
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    changed();
    return () => { clearInterval(tick); document.removeEventListener("visibilitychange", changed); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function updateDevices() {
      try {
        const response = await fetch("/local-perception-api/devices", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]), cache: "no-store" });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error ?? "无法读取设备列表");
        if (controller.signal.aborted) return;
        setDevices(body.devices);
        setDeviceId(current => current || body.devices.find((d: Device) => d.connected)?.id || "");
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "设备服务连接失败"); }
      finally { if (!controller.signal.aborted) timer = setTimeout(updateDevices, 5_000); }
    }
    void updateDevices();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!deviceId || !running || !visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function observe() {
      try {
        const response = await fetch(`/local-perception-api/observation?deviceId=${encodeURIComponent(deviceId)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), cache: "no-store" });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error ?? "画面暂不可用");
        if (controller.signal.aborted) return;
        const value = body as DisplaySnapshot;
        setSnapshot(value); setError("");
        setHistory(old => {
          const item = { at: value.observedAt, sequence: value.frame.sequence, page: labels[value.state.page], overlay: overlayLabels[value.state.overlay] };
          if (old[0]?.page === item.page && old[0]?.overlay === item.overlay) return old;
          return [item, ...old].slice(0, 12);
        });
      } catch (e) {
        if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : "取图失败"); setSnapshot(null); }
      } finally { if (!controller.signal.aborted) timer = setTimeout(observe, 350); }
    }
    void observe();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [deviceId, running, visible]);

  const frameAge = snapshot ? Math.max(0, clock - snapshot.frame.capturedAt) : null;
  const live = running && visible && !error && frameAge !== null && frameAge <= 1_500;
  const selected = snapshot?.elements.find(item => item.id === selectedId);
  const semantic = snapshot?.semantic;
  const lastCall=semantic?.recentCalls[0];
  const requestTiming=semantic?.elapsedMs!==undefined?ms(semantic.elapsedMs):lastCall?.outcome==="pending"?"进行中":lastCall?`最近 ${ms(lastCall.elapsedMs)}`:"尚未提交";
  const judgment = live && semantic?.status === "ready" && semantic.currentEvidenceMatched ? semantic.judgment : undefined;

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><Link className={styles.back} href="/">← 返回控制台</Link><h1>它现在看到了什么？</h1><p>ScreenHand · 本地视觉实验 / Local perception</p></div>
      <div className={styles.badges}><span>不上传截图 · 文字解释按需请求</span><span>观察面板不发送动作</span></div>
    </header>
    <section className={styles.toolbar} aria-label="观察设置">
      <label>设备 <select aria-label="选择观察设备" value={deviceId} onChange={event => selectDevice(event.target.value)}><option value="">选择在线设备</option>{devices.map(d => <option key={d.id} value={d.id}>{d.id} · {d.connected ? "控制器在线" : "离线"}</option>)}</select></label>
      <label><input type="checkbox" checked={showBoxes} onChange={event => setShowBoxes(event.target.checked)} />文字框</label>
      <label><input type="checkbox" checked={showIcons} onChange={event => setShowIcons(event.target.checked)} />无标签控件候选</label>
      <button type="button" onClick={()=>void requestExplanation()} disabled={!live||submitting||Boolean(semantic?.pendingRequestId)||semantic?.status==="disabled"||semantic?.status==="budget_exhausted"}>{submitting||semantic?.pendingRequestId?"解释请求处理中":"解释当前页面（一次）"}</button>
      <button type="button" onClick={() => setRunning(value => !value)}>{running ? "暂停观察" : "继续观察"}</button>
      <span className={`${styles.live} ${live ? styles.healthy : ""}`}>{live ? "● 画面新鲜" : !running ? "● 已暂停" : !visible ? "● 后台暂停" : "● 等待新鲜画面"}</span>
    </section>
    {error ? <div className={styles.error} role="alert">{error}。旧画面已清除，连接恢复后自动重试。</div> : null}
    <div className={styles.layout}>
      <section className={styles.cameraCard} aria-label="摄像头与识别框">
        <div className={styles.cardHeading}><strong>同一帧上的识别结果</strong><span>{snapshot ? `#${snapshot.frame.sequence}` : "等待摄像头"}</span></div>
        <div className={styles.cameraWell}>
          {snapshot ? <div className={styles.frame} style={{ aspectRatio: `${snapshot.frame.width} / ${snapshot.frame.height}` }}>
            {/* A local camera JPEG, intentionally not a separately advancing live stream. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={snapshot.frame.image} alt="与识别框对应的当前摄像头画面" />
            {showBoxes && snapshot.elements.map(item => <button type="button" key={item.id} className={`${styles.box} ${selectedId === item.id ? styles.selected : ""}`} aria-label={`查看文字：${item.text}`} title={item.text} onClick={() => setSelectedId(item.id)} style={{ left: `${item.bounds.left / snapshot.frame.width * 100}%`, top: `${item.bounds.top / snapshot.frame.height * 100}%`, width: `${item.bounds.width / snapshot.frame.width * 100}%`, height: `${item.bounds.height / snapshot.frame.height * 100}%` }} />)}
            {showIcons && snapshot.affordances.map((item, i) => <div key={i} className={styles.iconBox} title={`${item.label}（候选，不代表已理解功能）`} style={{ left: `${item.bounds.left / snapshot.frame.width * 100}%`, top: `${item.bounds.top / snapshot.frame.height * 100}%`, width: `${item.bounds.width / snapshot.frame.width * 100}%`, height: `${item.bounds.height / snapshot.frame.height * 100}%` }} />)}
          </div> : <div className={styles.empty}>{deviceId ? "正在读取摄像头…" : "等待在线设备"}</div>}
        </div>
        <p className={styles.note}>框和图片来自同一帧。坐标属于摄像头画面，不是机械臂触摸坐标；点击框只查看文字。</p>
        {selected ? <div className={styles.selection}><strong>{selected.text}</strong><span>X {Math.round(selected.center.x)} · Y {Math.round(selected.center.y)} · OCR 分数 {selected.confidence.toFixed(2)}</span></div> : null}
      </section>
      <div className={styles.details}>
        <section className={styles.card} aria-label="页面状态">
          <div className={styles.cardHeading}><strong>当前判断</strong><span className={styles.baseline}>{judgment?"文字模型推断 · 非动作验收":"未训练的规则基线"}</span></div>
          <h2>{judgment ? (judgment.app ?? (judgment.pageKind==="other"?"其他页面":labels[judgment.pageKind])) : snapshot ? labels[snapshot.state.page] : "等待观察"}</h2>
          {judgment ? <><p>{layoutLabels[judgment.layout]} · {judgment.summary}</p><p className={styles.note}>本地规则仍判断为「{labels[snapshot!.state.page]}」。文字模型独立补充解释，不代表任务已完成，也不会发出动作。</p><ul className={styles.evidence}>{semantic?.evidence?.map(item=><li key={item.id}>{item.id}：{item.text}</li>)}</ul></> : null}
          {semantic ? <p className={styles.note}>{semanticLabels[semantic.status]}。{semantic.model ? `${semantic.model} · 请求耗时 ${requestTiming} · 本服务累计 ${semantic.modelCalls} 次` : ""}{semantic.sourceSequence ? ` · 来源帧 #${semantic.sourceSequence}` : ""}{semantic.cacheHit ? " · 复用判断（不是重新推理）" : ""}{semantic.error ? ` · ${semantic.errorCode??"未分类"}：${semantic.error}` : ""}</p> : null}
          <p className={styles.note}>刷新只做本地观察，不调用模型。主动解释发送文字、图形候选、相对位置和最近动作回执，不上传截图；相同证据复用结果，失败不自动重试。每次服务启动最多 30 次解释请求；不包含独立任务规划的调用。网络等待不计入本地 OCR 耗时。</p>
          {semanticNotice?.deviceId===deviceId?<p className={styles.note} role="status">最近一次提交：{semanticNotice.message}</p>:null}
          <div className={styles.stateTags}><span>{snapshot ? overlayLabels[snapshot.state.overlay] : "覆盖层未知"}</span><span>键盘：{snapshot ? snapshot.state.keyboard ? "可见" : "未检测到" : "未知"}</span></div>
          <p className={styles.note}>{snapshot?.state.source === "recent_context" ? "基础页面来自短期记忆，当前被覆盖；并未重新确认。" : "只依据当前文字、布局和连续画面；不进行视频内容推理。"}</p>
          <ul className={styles.evidence}>{snapshot?.state.evidence.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
          <div className={styles.candidates}>{snapshot?.state.candidates.map(candidate => <div key={candidate.kind}><span>{labels[candidate.kind]}</span><meter min="0" max="1" value={candidate.score} aria-label={`${labels[candidate.kind]}证据分数`} /><small>{candidate.score.toFixed(2)}</small></div>)}</div>
          <p className={styles.note}>证据分数不是概率，也不是准确率。候选冲突或证据不足会显示“尚不能确定”。</p>
        </section>
        <section className={styles.card} aria-label="共享屏幕证据">
          <div className={styles.cardHeading}><strong>共享屏幕证据</strong><span>解释与规划共用</span></div>
          <p className={styles.note}>文字和图形来自当前帧；形状不等于功能。模型可推断用途，执行器仍需新画面验证。</p>
          <ul className={styles.evidence}>{snapshot?.scene?.controls.map(c=><li key={c.id}>{c.id} · {c.tone==="light"?"浅色":"深色"}{c.shape==="filled_circle"?"实心圆":"相机样式图形候选"}{snapshot.scene!.relations.filter(r=>r.controlId===c.id).map(r=>` · 在 ${snapshot.scene!.nodes.find(n=>n.id===r.textId)?.text??r.textId} ${({above:"上方",below:"下方",left:"左侧",right:"右侧"})[r.relation]}`).join("")}</li>)}</ul>
          <p>黄色文字：{snapshot?.scene?.accentText.join("、")||"未检测到"}</p>
          <p className={styles.note}>最近动作：{snapshot?.actionHistoryAvailable?(snapshot.scene?.recentActions.map(a=>`${a.action} · ${a.status}（仅机械回执，非画面验收）`).join("；")||"30 秒内没有动作回执"):"动作历史暂不可用"}</p>
        </section>
        <section className={styles.card} aria-label="文字模型调用记录">
          <div className={styles.cardHeading}><strong>文字模型调用记录</strong><span>本次服务启动 · 最近 5 次</span></div>
          <p className={styles.note}>仅记录原因、模型、时间与结果，不记录截图或 OCR 正文。重启后计数重置；不是单个手机任务的耗时。</p>
          <ol className={styles.history}>{semantic?.recentCalls?.map(call=><li key={call.requestId}>
            <time>{new Date(call.startedAt).toLocaleTimeString()}</time><span>{callReasons[call.reason]} · {callOutcomes[call.outcome]} · {ms(call.elapsedMs)}<br />{call.model} · 来源帧 #{call.sourceSequence}{call.error?` · ${call.errorCode??"未分类"}：${call.error}`:""}</span>
          </li>)}</ol>
          {!semantic?.recentCalls?.length?<p className={styles.note}>尚无模型调用。</p>:null}
        </section>
        <section className={styles.card} aria-label="识别性能">
          <div className={styles.cardHeading}><strong>本次耗时</strong><span>{snapshot?.timing.ocrCacheHit ? "复用识别缓存" : "重新识别"}</span></div>
          <div className={styles.metrics}>
            <div><small>取图与校验</small><strong>{ms(snapshot?.timing.fetchMs)}</strong></div><div><small>OCR</small><strong>{ms(snapshot?.timing.ocrMs)}</strong></div><div><small>状态判断</small><strong>{ms(snapshot?.timing.stateMs)}</strong></div>
            <div><small>后端总耗时</small><strong>{ms(snapshot?.timing.totalMs)}</strong></div><div><small>总耗时 P95</small><strong>{ms(snapshot?.metrics.totalP95Ms)}</strong></div><div><small>当前画面年龄</small><strong>{ms(frameAge)}</strong></div>
          </div>
          <p className={styles.note}>最近 {snapshot?.metrics.samples ?? 0} 次：OCR 实跑 {snapshot?.metrics.ocrRuns ?? 0} 次，缓存 {snapshot?.metrics.cacheHits ?? 0} 次。非缓存 OCR P95：{ms(snapshot?.metrics.ocrMissP95Ms)}。缓存超过 1 秒会重识别，防止小数字变化被漏掉。画面年龄从上传时间计算，不是完整摄像头延迟；以上均不代表任务完成速度。</p>
        </section>
        <section className={styles.card} aria-label="OCR文字列表">
          <div className={styles.cardHeading}><strong>识别到的文字</strong><span>{snapshot?.elements.length ?? 0} 项</span></div>
          <div className={styles.textList}>{snapshot?.elements.map(item => <button type="button" key={item.id} className={selectedId === item.id ? styles.textSelected : ""} onClick={() => setSelectedId(item.id)}><span>{item.text}</span><small>{Math.round(item.center.x)}, {Math.round(item.center.y)}</small></button>)}</div>
        </section>
        <section className={styles.card} aria-label="观察状态历史"><div className={styles.cardHeading}><strong>状态变化</strong><span>仅本次页面会话</span></div><ol className={styles.history}>{history.map(item => <li key={item.sequence}><time>{new Date(item.at).toLocaleTimeString()}</time><span>{item.page} · {item.overlay}</span></li>)}</ol></section>
      </div>
    </div>
  </main>;
}
