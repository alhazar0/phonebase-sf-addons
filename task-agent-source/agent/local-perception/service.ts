import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { ScreenObserver, type AgentFrame } from "../screen-observer";
import { LocalPageTracker } from "./state";
import { extractVisualFeatures } from "../local-control/visual-target";
import type { RecentAction } from "./action-context";
import {navigationLayout} from "../local-control/navigation-grounding";
import {detectVisualAffordances} from "../visual-affordance-detector";
import {detectObservedRegions} from "../local-control/observed-regions";
import {detectSearchBackdrop} from "../local-control/search-dismissal";
import {supplementGlyphs} from "./glyph-ocr";
import {detectOutlinedControls} from "../local-control/outlined-controls";
import {detectColoredControls} from "../local-control/colored-controls";

export class PerceptionUnavailable extends Error {}
type Sample = { elapsedMs: number; ocrMs: number; cacheHit: boolean };
type Session = { observer: ScreenObserver; tracker: LocalPageTracker; samples: Sample[]; lastSequence: number; lastCapturedAt: number; lastOcrAt: number; dimensions: string; lastUsed: number; pending?: Promise<PerceptionSnapshot> };
export type PerceptionSnapshot = Awaited<ReturnType<LocalPerceptionService["capture"]>>;

export function readFrameHeader(response: Response, suffix: string): number {
  const raw = response.headers.get(`x-screenhand-${suffix}`) ?? response.headers.get(`x-phonebase-${suffix}`);
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || value <= 0) throw new PerceptionUnavailable(`Invalid camera ${suffix} metadata`);
  return value;
}

export function requireFreshFrame(capturedAt: number, now = Date.now(), maximumAgeMs = 1_500) {
  if (!Number.isFinite(capturedAt) || now - capturedAt > maximumAgeMs || capturedAt - now > 1_000) {
    throw new PerceptionUnavailable("Camera frame is stale or its clock is invalid. No old image will be presented as live.");
  }
}

/** Deliberately has no action client, task compiler, LLM, VLM or external inference dependency. */
export class LocalPerceptionService {
  private sessions = new Map<string, Session>();
  private baseUrl: URL;
  // UI names are identifiers, not prose: language correction demotes valid
  // mixed-letter/digit brands and may rewrite user names. Keep literal OCR.
  constructor(baseUrl: string, private fetcher: typeof fetch = fetch, private makeObserver = () => new ScreenObserver({ ocrMode: "literal" }),
    private readActions?:(deviceId:string,signal:AbortSignal)=>Promise<RecentAction[]>) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(this.baseUrl.hostname) || this.baseUrl.username || this.baseUrl.password) throw new Error("Local perception requires a loopback HTTP control plane");
  }

  private get(path: string, signal: AbortSignal) {
    return this.fetcher(new URL(path, this.baseUrl), { method: "GET", signal, cache: "no-store", redirect: "error" });
  }

  async devices() {
    const response = await this.get("/api/v1/devices", AbortSignal.timeout(3_000));
    if (!response.ok) throw new PerceptionUnavailable(`Device list HTTP ${response.status}`);
    const body = await response.json() as { devices?: Array<{ id: string; connected: boolean; status: string }> };
    return (body.devices ?? []).map(({ id, connected, status }) => ({ id, connected, status }));
  }

  observe(deviceId: string, options: { freshOcr?: boolean; signal?: AbortSignal } = {}): Promise<PerceptionSnapshot> {
    options.signal?.throwIfAborted();
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(deviceId)) throw new Error("Invalid device ID");
    for (const [id, session] of this.sessions) if (!session.pending && Date.now() - session.lastUsed > 300_000) this.sessions.delete(id);
    let session = this.sessions.get(deviceId);
    if (!session) {
      if (this.sessions.size >= 8) throw new PerceptionUnavailable("Too many active observation sessions");
      session = { observer: this.makeObserver(), tracker: new LocalPageTracker(), samples: [], lastSequence: 0, lastCapturedAt: 0, lastOcrAt: 0, dimensions: "", lastUsed: Date.now() };
      this.sessions.set(deviceId, session);
    }
    session.lastUsed = Date.now();
    // An action verifier must never inherit an OCR job started before its action.
    if (session.pending) return options.freshOcr
      ? session.pending.catch(() => undefined).then(() => this.observe(deviceId, options))
      : session.pending;
    const active = session;
    active.pending = this.capture(deviceId, active, options.signal, options.freshOcr).catch(error => {
      active.observer.reset();
      active.tracker.reset();
      active.lastSequence = 0;
      throw error;
    }).finally(() => { active.pending = undefined; });
    return active.pending;
  }

  async capture(deviceId: string, session: Session, externalSignal?: AbortSignal, freshOcr=false) {
    const started = performance.now();
    const timeout = AbortSignal.timeout(8_000);
    const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
    const history=this.readActions?.(deviceId,signal).then(actions=>({actions,available:true})).catch(()=>({actions:[] as RecentAction[],available:false}));
    const response = await this.get(`/api/v1/devices/${encodeURIComponent(deviceId)}/screenshot`, signal);
    if (!response.ok) throw new PerceptionUnavailable(`Camera HTTP ${response.status}; check camera connection and pairing`);
    const sequence = readFrameHeader(response, "frame-sequence");
    const capturedAt = readFrameHeader(response, "captured-at");
    const width = readFrameHeader(response, "frame-width");
    const height = readFrameHeader(response, "frame-height");
    requireFreshFrame(capturedAt);
    if (width * height > 12_000_000) throw new PerceptionUnavailable("Camera image exceeds pixel limit");
    if (Number(response.headers.get("content-length")) > 8_000_000) throw new PerceptionUnavailable("Camera image exceeds byte limit");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 8_000_000 || bytes[0] !== 255 || bytes[1] !== 216) throw new PerceptionUnavailable("Invalid camera JPEG");
    const metadata = await sharp(bytes).metadata();
    if (metadata.width !== width || metadata.height !== height) throw new PerceptionUnavailable("Camera dimensions disagree with JPEG metadata");
    const dimensions = `${width}x${height}`;
    if (sequence < session.lastSequence || capturedAt < session.lastCapturedAt || (session.dimensions && session.dimensions !== dimensions)) {
      session.observer.reset(); session.tracker.reset();
    } else if (!freshOcr && session.lastOcrAt > 0 && capturedAt - session.lastOcrAt >= 1_000) {
      // A tiny changed number may fall below full-frame delta thresholds.
      // Bound cached text age instead of claiming that a stable image never changes.
      session.observer.reset();
    }
    const fetchMs = performance.now() - started;
    const frame: AgentFrame = { bytes, mimeType: "image/jpeg", sequence, capturedAt, width, height };
    // Preserve scene identities/geometry history while independently rerunning
    // full OCR. Verification must never inherit cached or partially reused text.
    const observation = await session.observer.observe(frame, signal, {freshOcr});
    observation.elements=await supplementGlyphs(bytes,observation.elements,signal);
    signal.throwIfAborted();
    if (!observation.ocrCacheHit) session.lastOcrAt = capturedAt;
    requireFreshFrame(capturedAt);
    const stateStarted = performance.now();
    const state = session.tracker.observe(observation);
    const stateMs = performance.now() - stateStarted;
    const publicFrame={sequence,capturedAt,width,height,image:`data:image/jpeg;base64,${bytes.toString("base64")}`};
    const visualStarted=performance.now();
    // Launcher icons often contain letters. The normal unlabeled-control path
    // excludes OCR regions and would erase exactly those icons. On a verified
    // grid, retain image components; label-to-icon binding still requires a
    // unique separate shape above the caption in this SAME frame.
    const layout=navigationLayout({frame:publicFrame,state,elements:observation.elements});
    const baseAffordances=layout.home||layout.catalogMode==="labeled_list"
      ? (await detectVisualAffordances(bytes,{viewport:{width,height},sampleWidth:240,maximumCandidates:64})).candidates
      : observation.visualAffordances??[];
    const colored=(await Promise.all([detectColoredControls(bytes,width,height),detectOutlinedControls(bytes,width,height)])).flat();
    const affordances=[...baseAffordances,...colored.filter(a=>!baseAffordances.some(b=>Math.hypot(a.center.x-b.center.x,a.center.y-b.center.y)<Math.min(a.bounds.width,b.bounds.width)*.5))];
    const visual=await extractVisualFeatures({frame:publicFrame,elements:observation.elements,affordances});
    const regions=await detectObservedRegions({frame:publicFrame,state,elements:observation.elements,affordances});
    const searchBackdrop=await detectSearchBackdrop({frame:publicFrame,state,elements:observation.elements,affordances});
    const visualMs=performance.now()-visualStarted;
    const context=await history;
    signal.throwIfAborted();requireFreshFrame(capturedAt);
    const elapsedMs = performance.now() - started;
    session.samples.push({ elapsedMs, ocrMs: observation.ocrElapsedMs, cacheHit: observation.ocrCacheHit });
    if (session.samples.length > 120) session.samples.shift();
    session.lastSequence = sequence; session.lastCapturedAt = capturedAt; session.dimensions = dimensions;
    const percentile = (values: number[], p: number) => values.length ? Math.round([...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] * 10) / 10 : null;
    return {
      ok: true as const, deviceId, observedAt: Date.now(), generatedModelCalls: 0, physicalActionsAllowed: false,
      coordinateSpace: "raw-camera" as const, trainedClassifier: false,
      frame:publicFrame,visual,searchBackdrop,regions,recentActions:context?.actions.filter(a=>a.at<=capturedAt)??[],actionHistoryAvailable:context?.available??false,
      state, elements: observation.elements, affordances,
      changeKind: observation.changeKind, changeRatio: observation.changeRatio,
      timing: { fetchMs, observationMs: observation.observationElapsedMs, ocrMs: observation.ocrElapsedMs, ocrCacheHit: observation.ocrCacheHit, ocrCapturedAt: session.lastOcrAt, ocrAgeMs: Date.now() - session.lastOcrAt, stateMs,visualMs, totalMs: elapsedMs, frameAgeMs: Date.now() - capturedAt },
      metrics: { samples: session.samples.length, totalP50Ms: percentile(session.samples.map(x => x.elapsedMs), 0.5), totalP95Ms: percentile(session.samples.map(x => x.elapsedMs), 0.95), ocrMissP95Ms: percentile(session.samples.filter(x => !x.cacheHit).map(x => x.ocrMs), 0.95), ocrRuns: session.samples.filter(x => !x.cacheHit).length, cacheHits: session.samples.filter(x => x.cacheHit).length },
    };
  }
}
