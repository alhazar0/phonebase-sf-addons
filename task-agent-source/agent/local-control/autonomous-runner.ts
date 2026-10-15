import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ScreenHandSemanticAction } from "../action-contract";
import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import { requireFreshFrame } from "../local-perception/service";
import { buildTextDocument } from "../local-perception/text-semantics";
import { LocalClosedLoopExecutor, assessExpectation, calibrationFingerprint, type ControlDependencies, type LocalView, type StepReport } from "./executor";
import { validateGeometry } from "./geometry";
import { autonomousDecisionSchema, decisionRequest, explorationRequest, fieldRequest, type AutonomousCapability, type AutonomousDecision, type AutonomousPlanner, type ObjectiveEvidence, type PlannerHistory, type PlanningContext, type RecoveryExclusion } from "./autonomous-planner";
import {fillVisibleField, fieldValueMatches, type FieldEntryReport} from "./field-entry";
import {stepCapabilities} from "./autonomous-planner";
import {localHomeDecision,localAppDecision,navigationLayout,appTitleEvidence,catalogEntries,requestedAppName} from "./navigation-grounding";
import {canonicalLabel} from "./text-label";
import type {BoundAppIcon} from "./icon-library";
import {sameObservedRegion} from "./observed-regions";
import {observedTarget,regionHasUniqueText,regionContains} from "./interaction";
import {messageSendRequested,validateMessageDraft} from "./message-effect";
import {systemSearchResultTarget} from './search-dismissal';

const normalize = canonicalLabel;
// Explicit repeat requests require a fresh effect; an old visible answer is
// insufficient. This is task intent, independent of application or coordinates.
export const requiresFreshAction=(goal:string)=>/(重新|再次|再算|再输入|再按|\brepeat\b|\bagain\b|\bre-enter\b)/i.test(goal);
type RunnerIntent = (ReturnType<typeof decisionRequest> | ReturnType<typeof explorationRequest> | ReturnType<typeof fieldRequest>)["intent"];
function intentKey(intent: RunnerIntent): string {
  if(intent.type==='fill_field'&&intent.targetRegion){const r=intent.targetRegion;return JSON.stringify({type:intent.type,text:intent.text,purpose:intent.purpose,x:Math.round((r.left+r.right)*10),y:Math.round((r.top+r.bottom)*10)});}
  if(intent.type==="tap_observed"){const r=intent.target.region;return JSON.stringify({type:intent.type,text:normalize(intent.target.text),x:Math.round((r.left+r.right)*10),y:Math.round((r.top+r.bottom)*10)});}
  if (intent.type === "tap_text" || intent.type === "long_press_text")
    return JSON.stringify({type:intent.type,text:normalize(intent.text),region:intent.region??null});
  if (intent.type === "open_app") return JSON.stringify({type:intent.type,text:normalize(intent.text)});
  return JSON.stringify(intent);
}
function sameIntent(a:RunnerIntent,b:RunnerIntent){
  if(a.type==="tap_observed"&&b.type==="tap_observed"){
    const x=a.target.region,y=b.target.region;
    return normalize(a.target.text)===normalize(b.target.text)&&Math.abs(x.left+x.right-y.left-y.right)<.05&&Math.abs(x.top+x.bottom-y.top-y.bottom)<.05;
  }
  return intentKey(a)===intentKey(b);
}
function attemptKey(view: LocalView, intent: RunnerIntent, objective: number): string {
  const layout = navigationLayout(view);
  return JSON.stringify([objective, intent.type === "open_app" ? layout.home ? "launcher" : layout.catalogMode : sceneKey(view), intentKey(intent)]);
}
function recoveryOperation(intent: RunnerIntent): RecoveryExclusion["operation"] {
  return {type:intent.type,...(intent.type==="tap_observed"?{text:intent.target.text}:{}),...("text" in intent?{text:intent.text}:{}),...("key" in intent?{key:intent.key}:{}),
    ...("regionId" in intent?{regionId:intent.regionId}:{}),
    ...("direction" in intent?{direction:intent.direction}:{}),...(intent.type==="tap_visual"?{shape:intent.selector.shape}:{})};
}
export function confirmsTexts(texts: string[], first: LocalView, second: LocalView): boolean {
  const distinct = new Set(texts.map(normalize));
  if (distinct.size < 2 || distinct.size !== texts.length || first.deviceId !== second.deviceId ||
    first.frame.width!==second.frame.width||first.frame.height!==second.frame.height||
    second.frame.sequence <= first.frame.sequence || second.frame.capturedAt <= first.frame.capturedAt) return false;
  if(![first,second].every(view=>!view.timing.ocrCacheHit&&view.timing.ocrCapturedAt===view.frame.capturedAt&&view.state.overlay==="none"))return false;
  // Text existence is not a click selector: a heading may repeat in a tab bar.
  // Require two distinct high-confidence labels, each spatially corroborated
  // in the second frame. Action selection still requires a unique target.
  return texts.every(text=>{
    const matches=(view:LocalView)=>view.elements.filter(e=>e.confidence>=.9&&normalize(e.text)===normalize(text));
    return matches(first).some(a=>matches(second).some(b=>Math.abs(a.center.x-b.center.x)<=first.frame.width*.02&&Math.abs(a.center.y-b.center.y)<=first.frame.height*.02));
  });
}
export function sceneKey(view: LocalView): string {
  const doc = buildTextDocument(view);
  // Clock/frame IDs/last motor receipt must not defeat repeated-action detection.
  return createHash("sha256").update(JSON.stringify({text: doc.nodes.map(n => normalize(n.text)).sort(),
    overlay: doc.overlay, keyboard: doc.keyboard, controls: doc.controls.map(c => c.shape).sort()})).digest("hex");
}
/** Conservative retry veto only; similarity never proves success or permits a tap. */
export function samePageForRetry(first: LocalView, second: LocalView): boolean {
  if (first.deviceId !== second.deviceId || first.frame.width !== second.frame.width ||
    first.frame.height !== second.frame.height || first.state.keyboard !== second.state.keyboard ||
    first.state.overlay !== second.state.overlay) return false;
  const anchors = (view: LocalView) => buildTextDocument(view).nodes.filter(n =>
    normalize(n.text).length >= 3 && /\p{L}/u.test(n.text) && n.box[1] >= 120 &&
    (!view.state.keyboard || n.box[1] < 600));
  const a = anchors(first), b = anchors(second), used = new Set<number>();
  let matched = 0;
  for (const node of a) {
    const index = b.findIndex((other, i) => !used.has(i) && normalize(node.text) === normalize(other.text) &&
      Math.abs(node.box[0] - other.box[0]) <= 20 && Math.abs(node.box[1] - other.box[1]) <= 20);
    if (index >= 0) {used.add(index); matched++;}
  }
  return matched >= 3 && matched / Math.max(a.length, b.length) >= .75;
}
export type AutonomousReport = {
  id: string; deviceId: string; goal: string;
  status: "running" | "preview" | "observed_complete" | "blocked" | "budget_exhausted" | "action_uncertain" | "failed";
  phase: "observing" | "planning" | "revalidating" | "acting" | "finished";
  error?: string; objectives: ObjectiveEvidence[]; decisions: Array<{sourceSequence: number; elapsedMs: number; source?:"local_navigation"|"model";decision?: AutonomousDecision; error?: string; notes?: string[]; recovery?: PlanningContext["recovery"]}>;
  steps: StepReport[];
  fieldEntries: Array<FieldEntryReport & {purpose:"query"|"form"|"recipient"|"message"}>;
  resultKind: "visual"|"form_storage"|"communication";
  message?:{recipient:string;body:string;status:"prepared"|"outgoing_visible"|"unverified"|"uncertain";submitted:boolean;deliveryVerified:false};
  navigationTarget?:string;
  navigationDiscovery?:{target:string;objectiveIndex:number;remainingSteps:number;status:"active"|"returned_to_planner"};
  formStorage?: {values:string[];committed:boolean;departed:boolean;reopened:boolean;commitSequence:number;commitSubmissionCount:number;
    departureSubmissionCount?:number;departureSequences?:[number,number];reopenSequences?:[number,number]};
  submissions: Array<{key: string; action: ScreenHandSemanticAction; state: "dispatching" | "completed" | "uncertain"; receiptId?: string; elapsedMs: number}>;
  modelCalls: number; imageUploads: number; terminalInterventions: 0;
  staleObservationRetries: number;
  planningTimeoutRetries: number;
  capabilities?: PlanningContext["capabilities"];
  requiredCapabilities: AutonomousCapability[];
  completionEvidence?: {texts: string[]; sequences: [number, number]; level: "model_selected_visual_objectives"|"local_navigation"|"saved_record_reopened"; deliveryOrStorageVerified: boolean};
  timing: {totalMs: number; observationMs: number; planningMs: number; executionMs: number; actionMs: number; verificationMs: number; checkpointMs: number};
};
export type AutonomousOptions = {
  execute: boolean; signal: AbortSignal; maximumDecisions?: number; maximumActions?: number; timeoutMs?: number;
  verificationMs?: number; checkpoint?: (report: AutonomousReport) => Promise<void>;
  visibleTextEntry?:boolean;
  resolveAppIcons?:(view:LocalView,target?:string)=>Promise<BoundAppIcon[]>;
};

/** Reuses the calibrated executor, but chooses the next action from new evidence
 * after every outcome. An inaccurate predicted page is not a prewritten-plan stop. */
export class AutonomousPhoneRunner {
  private running = false;
  constructor(private deps: ControlDependencies, private planner: AutonomousPlanner, private fillField=fillVisibleField) {}
  async run(goal: string, options: AutonomousOptions): Promise<AutonomousReport> {
    if (this.running) throw new Error("An autonomous task is already running");
    if (!goal.trim() || goal.length > 1000) throw new Error("Goal must contain 1–1000 characters");
    const maximumDecisions = options.maximumDecisions ?? 12, maximumActions = options.maximumActions ?? 12, timeoutMs = options.timeoutMs ?? 90_000;
    for (const [value, min, max] of [[maximumDecisions, 1, 30], [maximumActions, 1, 160], [timeoutMs, 1000, 180_000], [options.verificationMs ?? 1800, 100, 15000]]) {
      if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid autonomous execution budget");
    }
    this.running = true;
    const start = performance.now(), signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
    const report: AutonomousReport = {id: randomUUID(), deviceId: this.deps.deviceId, goal, status: "running", phase: "observing",
      objectives: [], requiredCapabilities: [], decisions: [], steps: [], fieldEntries:[], resultKind:"visual", submissions: [], modelCalls: 0, imageUploads: 0, terminalInterventions: 0, staleObservationRetries: 0, planningTimeoutRetries: 0,
      timing: {totalMs: 0, observationMs: 0, planningMs: 0, executionMs: 0, actionMs: 0, verificationMs: 0, checkpointMs: 0}};
    const checkpoint = async () => {
      report.imageUploads=this.planner.imageUploads??0;
      report.timing.totalMs = performance.now() - start;
      const at = performance.now();
      try {await options.checkpoint?.(report);} finally {report.timing.checkpointMs += performance.now() - at;}
    };
    let profile: ScreenHandCalibrationProfile | null = null, fingerprint = "", latest: LocalView | undefined, notBefore = 0;
    const recentViews: LocalView[] = [];
    const observe = async (s: AbortSignal) => {
      const at = performance.now();
      try {
        if (Date.now() < notBefore) await delay(notBefore - Date.now(), undefined, {signal: s});
        let view: LocalView | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {view = await this.deps.observe(s); requireFreshFrame(view.frame.capturedAt); break;}
          catch (error) {
            if (s.aborted || attempt === 2 || !(error instanceof Error) || !error.message.startsWith("Camera frame is stale or its clock is invalid")) throw error;
            // Read-only retries obtain a NEW frame; never relax freshness or
            // repeat a motor request. OCR contention can consume a frame's TTL.
            report.staleObservationRetries++; await delay(80, undefined, {signal: s});
          }
        }
        if (!view) throw new Error("No camera observation"); s.throwIfAborted();
        if (!profile || view.deviceId !== this.deps.deviceId) throw new Error("Observation device or calibration mismatch");
        validateGeometry(profile, view); requireFreshFrame(view.frame.capturedAt);
        if(options.resolveAppIcons){
          view.appIcons=await options.resolveAppIcons(view,report.navigationDiscovery?.status==="active"?report.navigationDiscovery.target:report.navigationTarget??requestedAppName(goal)??undefined);
          s.throwIfAborted();requireFreshFrame(view.frame.capturedAt);
        }
        if (view.timing.ocrCacheHit || view.timing.ocrCapturedAt !== view.frame.capturedAt) throw new Error("Autonomy requires uncached OCR from this frame");
        if (latest && (view.frame.sequence < latest.frame.sequence || view.frame.capturedAt < latest.frame.capturedAt)) throw new Error("Camera stream restarted");
        latest = view; recentViews.push(view); if (recentViews.length > 8) recentViews.shift(); return view;
      } finally {report.timing.observationMs += performance.now() - at;}
    };
    const freshAfter = async (before?: LocalView) => {
      for (let i = 0; i < 5; i++) {
        const view = await observe(signal);
        if ((!before || (view.frame.sequence > before.frame.sequence && view.frame.capturedAt > before.frame.capturedAt)) && view.frame.capturedAt >= notBefore) return view;
        await delay(80, undefined, {signal});
      }
      throw new Error("No independent post-action camera frame");
    };
    const grounded:ControlDependencies = {...this.deps, observe, act: async (action, s, key) => {
      if (report.submissions.length >= maximumActions) throw new Error("Physical action budget exhausted");
      const entry: AutonomousReport["submissions"][number] = {key, action, state: "dispatching", elapsedMs: 0};
      report.submissions.push(entry);
      // Durable intent BEFORE physical submission. An uncertain intent is never
      // automatically resumed after a crash or sent twice under a new key.
      await checkpoint(); s.throwIfAborted();
      const at = performance.now();
      try {
        const result = await this.deps.act(action, s, key);
        entry.receiptId = result.receipt.id; entry.state = result.receipt.status === "completed" ? "completed" : "uncertain";
        if (entry.state === "completed") notBefore = Date.now() + 120;
        return result;
      } catch (error) {entry.state = "uncertain"; throw error;}
      finally {entry.elapsedMs = performance.now() - at; report.timing.actionMs += entry.elapsedMs; await checkpoint();}
    }};
    const executor = new LocalClosedLoopExecutor(grounded);
    const valuesVisible=(values:string[],view:LocalView)=>values.every(value=>view.elements.filter(e=>e.confidence>=.65&&fieldValueMatches(e.text,value)).length===1);
    const attempted = new Set<string>(), rejectedContracts=new Set<string>(), history: PlannerHistory = [],statefulObjectives=new Map<number,LocalView>();
    const recordedAttempts: Array<{objective: number; intent: RunnerIntent; view: LocalView; step: number; status: StepReport["status"]; error?: string; stalled?: boolean}> = [];
    const excludedAttempts = (view: LocalView, objective: number) => recordedAttempts.filter(previous =>
      previous.objective === objective && (attemptKey(previous.view, previous.intent, objective) === attemptKey(view, previous.intent, objective) ||
        ((previous.stalled || ["unverified","blocked"].includes(previous.status)) && samePageForRetry(previous.view, view))));
    let consecutiveNoAction = 0, objectivesInitialized = false,stalledCatalogSwipes=0;
    try {
      signal.throwIfAborted(); profile = await this.deps.getCalibration(signal);
      if (!profile) throw new Error("No verified screen calibration"); fingerprint = calibrationFingerprint(profile);
      while (report.decisions.length < maximumDecisions) {
        signal.throwIfAborted(); report.phase = "observing";
        const [view, device, currentProfile] = await Promise.all([freshAfter(), this.deps.getDevice(signal), this.deps.getCalibration(signal)]);
        if (!currentProfile || calibrationFingerprint(currentProfile) !== fingerprint) throw new Error("Calibration changed during autonomous task");
        if (device.id !== this.deps.deviceId || !device.connected || !device.state?.grbl?.homed || device.state.grbl.state !== "Idle" ||
          device.state.grbl.activeOperation || device.state.grbl.liveTouch) throw new Error("Device is not connected, homed and idle");
        const capabilities:PlanningContext["capabilities"] = {home: !!profile.navigation?.home && !!device.capabilities.actions.phone_key?.available,
          inputText: (profile.keyboard?.strict === true && !!device.capabilities.actions.input_text?.available)||
            (options.visibleTextEntry===true&&!!device.capabilities.actions.tap?.available),
          longPress: !!device.capabilities.actions.long_press?.available, swipe: !!device.capabilities.actions.swipe?.available, tap: !!device.capabilities.actions.tap?.available};
        capabilities.unavailableReasons={};
        if(!capabilities.inputText)capabilities.unavailableReasons.inputText="Field-bound visible text entry is disabled and no verified native keyboard profile is available";
        if(!capabilities.home)capabilities.unavailableReasons.home="A verified Home strategy and phone_key capability are required";
        for(const key of ["tap","swipe","longPress"] as const)if(!capabilities[key])capabilities.unavailableReasons[key]="The device does not advertise this action";
        report.capabilities=capabilities;
        const discovery=report.navigationDiscovery,layoutNow=navigationLayout(view);
        if(discovery?.status==="active"&&(!layoutNow.home&&!layoutNow.catalog||view.state.overlay!=="none"||discovery.remainingSteps<=0||
          discovery.objectiveIndex!==report.objectives.findIndex(o=>!o.verified)))discovery.status="returned_to_planner";
        const compound=report.objectives.length>0&&(report.objectives.length!==1||!requestedAppName(report.objectives[0].description));
        const exclusions = excludedAttempts(view, report.objectives.findIndex(o=>!o.verified));
        let reflex=localHomeDecision(goal,view,report.objectives)??
          (discovery?.status==="active"?localAppDecision(goal,view,report.objectives,discovery.target,true):compound?null:localAppDecision(goal,view,report.objectives,report.navigationTarget));
        if(this.planner.preferModelNavigation&&reflex?.kind==="action")reflex=null;
        if (reflex?.kind === "action") {
          try {
            const candidate = reflex.step?.verification === "observe" ? explorationRequest(reflex) : decisionRequest(reflex);
            if (exclusions.some(previous => intentKey(previous.intent) === intentKey(candidate.intent))) reflex = null;
          } catch { /* Existing contract validation reports invalid local proposals below. */ }
        }
        if(reflex&&discovery?.status==="active")discovery.remainingSteps--;
        report.phase = "planning"; if(!reflex)report.modelCalls++;
        const recovery = {excludedActions:exclusions.map(previous=>({operation:recoveryOperation(previous.intent),step:previous.step,
          reason:previous.error??"This action was already attempted on this page; choose a different route"}))};
        const trace: AutonomousReport["decisions"][number] = {sourceSequence: view.frame.sequence, elapsedMs: 0,source:reflex?"local_navigation":"model",...(exclusions.length?{recovery}: {})}; report.decisions.push(trace); await checkpoint();
        const at = performance.now(); let decision: AutonomousDecision;
        try {decision = autonomousDecisionSchema.parse(reflex??await this.planner.decide({goal, view, objectives: structuredClone(report.objectives), history: structuredClone(history), capabilities,
          visibleTextEntry:options.visibleTextEntry,navigationTarget:discovery?.status==="active"?discovery.target:report.navigationTarget,fieldEntries:structuredClone(report.fieldEntries),formStorage:structuredClone(report.formStorage),
          recovery:structuredClone(recovery)}, signal)); trace.decision = decision;}
        catch (error) {
          trace.error = error instanceof Error ? error.message : "Decision failed";
          // A timed-out read-only model request cannot have moved hardware.
          // Retry once per run, on a NEW observation and inside all original
          // time/call budgets. Never retry a motor receipt or change providers.
          if (error instanceof Error && ["TimeoutError","AbortError"].includes(error.name) && !signal.aborted &&
            options.execute && report.planningTimeoutRetries < 1 && report.modelCalls < maximumDecisions) {
            report.planningTimeoutRetries++;
            trace.notes=["Read-only inference timeout; one fresh-observation retry, no motor replay"];
            history.push({operation:null,status:"planning_retry",error:"Model request timed out; no action sent for this decision",observedTexts:view.elements.filter(e=>e.confidence>=.65).map(e=>e.text).slice(0,64)});
            await checkpoint();continue;
          }
          throw error;
        }
        finally {trace.elapsedMs = performance.now() - at; report.timing.planningMs += trace.elapsedMs;}
        if (!objectivesInitialized) {
          if (!decision.objectives.length && decision.kind !== "blocked") throw new Error("First decision omitted goal objectives");
          report.objectives = decision.objectives.map(description => ({description}));
          report.resultKind=messageSendRequested(goal)?"communication":decision.resultKind??"visual";
          objectivesInitialized = true;
        } else if (decision.objectives.length) {
          if (decision.objectives.length !== report.objectives.length || decision.objectives.some((text, index) => text !== report.objectives[index].description)) {
            throw new Error("Planner attempted to rewrite frozen objectives");
          }
          // Idempotent echo: retain host-owned objectives AND their evidence.
          // Do not mutate the recorded provider response or ask another model.
          trace.notes = ["Identical objective echo accepted; existing goal state preserved"];
        }
        const appOnly=!!requestedAppName(goal)&&report.objectives.length===1&&!!requestedAppName(report.objectives[0].description);
        if(decision.navigationTarget&&appOnly&&report.resultKind==="visual"){
          if(report.navigationTarget&&normalize(report.navigationTarget)!==normalize(decision.navigationTarget)){
            if(recentViews.some(v=>v.elements.some(e=>e.confidence>=.9&&normalize(e.text)===normalize(report.navigationTarget!))))throw new Error("Planner attempted to rewrite an observed app target");
            trace.notes=[...(trace.notes??[]),"Unobserved app-label hypothesis revised; original user goal and objectives remain frozen"];
          }
          report.navigationTarget=decision.navigationTarget;
        }
        // A compound task may delegate just its CURRENT app-discovery subgoal.
        // Local navigation cannot mark any of its frozen outcomes complete.
        if(!reflex&&decision.kind==="action"&&decision.navigationTarget&&!appOnly&&report.resultKind==="visual"&&
          (layoutNow.home||layoutNow.catalog)&&view.state.overlay==="none") {
          const objectiveIndex=report.objectives.findIndex(o=>!o.verified);
          const previous=report.navigationDiscovery;
          if(objectiveIndex>=0&&(!previous||previous.objectiveIndex!==objectiveIndex||normalize(previous.target)!==normalize(decision.navigationTarget)))
            report.navigationDiscovery={target:decision.navigationTarget,objectiveIndex,remainingSteps:8,status:"active"};
        }
        const required=stepCapabilities(decision);
        report.requiredCapabilities=[...new Set([...report.requiredCapabilities,...required])];
        const ignored=(decision.requiredCapabilities??[]).filter(c=>!required.includes(c));
        if(ignored.length)trace.notes=[...(trace.notes??[]),`Advisory capabilities not used by this step: ${ignored.join(", ")}; actual operation gates remain enforced`];
        const missing=required.find(key=>!capabilities[key]);
        if(report.resultKind==="form_storage"&&!capabilities.inputText&&!report.formStorage?.committed){report.status="blocked";report.error="Creating a new record requires verified text entry, which is unavailable";break;}
        if(missing){
          trace.error=`Required capability unavailable: ${missing}; ${capabilities.unavailableReasons[missing]}. Choose a route using available capabilities; no action sent`;
          history.push({operation:decision.step,status:"alternative_required",error:trace.error,observedTexts:view.elements.filter(e=>e.confidence>=.65).map(e=>e.text).slice(0,64)});
          if(!options.execute||++consecutiveNoAction>=3){report.status="blocked";report.error=trace.error;break;}
          await checkpoint();continue;
        }
        if ((decision.kind === "action") !== (decision.step !== null) || (decision.kind !== "complete" && decision.finalEvidence.length)) throw new Error("Inconsistent decision fields");
        if (decision.achieved.some(proof => !report.objectives[proof.objective])) {
          trace.error = "Decision cites a nonexistent objective; use the provided zero-based indices";
          history.push({operation: decision.step, status:"proposal_rejected", error:trace.error,
            observedTexts:view.elements.filter(e=>e.confidence>=.65).map(e=>e.text).slice(0,64)});
          if (!options.execute || ++consecutiveNoAction >= 3) {report.status="blocked";report.error=trace.error;break;}
          await checkpoint(); continue;
        }
        await checkpoint();
        if (!options.execute) {report.status = "preview"; break;}
        if (decision.kind === "blocked") {report.status = "blocked"; report.error = decision.reason; break;}

        // Inference may have taken several seconds. Re-observe before binding
        // targets; never move using a stale planning frame's coordinates.
        report.phase = "revalidating";
        const [current, decisionProfile] = await Promise.all([freshAfter(view), this.deps.getCalibration(signal)]);
        if (!decisionProfile || calibrationFingerprint(decisionProfile) !== fingerprint) throw new Error("Calibration changed during decision");
        const storage=report.formStorage;
        if(storage?.committed&&view.frame.sequence>storage.commitSequence&&current.frame.sequence>view.frame.sequence&&
          !view.state.keyboard&&!current.state.keyboard&&view.state.overlay==="none"&&current.state.overlay==="none") {
          if(report.submissions.length>storage.commitSubmissionCount&&!valuesVisible(storage.values,view)&&!valuesVisible(storage.values,current)&&!storage.departed) {
            storage.departed=true;storage.departureSequences=[view.frame.sequence,current.frame.sequence];storage.departureSubmissionCount=report.submissions.length;
          }else if(storage.departed&&report.submissions.length>storage.departureSubmissionCount!&&view.frame.sequence>storage.departureSequences![1]&&valuesVisible(storage.values,view)&&valuesVisible(storage.values,current)) {
            storage.reopened=true;storage.reopenSequences=[view.frame.sequence,current.frame.sequence];
          }
        }
        for (const proof of decision.achieved) {
          const objective = report.objectives[proof.objective];
          if (!objective) throw new Error("Decision cites a nonexistent objective");
          if(requiresFreshAction(goal)&&!report.submissions.length&&proof.objective===report.objectives.length-1)continue;
          const baseline=statefulObjectives.get(proof.objective),display=proof.display;
          if(!objective.verified&&baseline&&display&&report.objectives.slice(0,proof.objective).every(o=>o.verified)&&
            !regionHasUniqueText(baseline,display.region,display.text)&&
            [view,current].every(v=>regionHasUniqueText(v,display.region,display.text))){
            objective.verified={texts:[display.text],sequences:[view.frame.sequence,current.frame.sequence],capturedAt:[view.frame.capturedAt,current.frame.capturedAt]};
          }
          if (!objective.verified && !statefulObjectives.has(proof.objective) && report.objectives.slice(0, proof.objective).every(o => o.verified) && confirmsTexts(proof.evidenceTexts, view, current)) {
            objective.verified = {texts: proof.evidenceTexts, sequences: [view.frame.sequence, current.frame.sequence], capturedAt: [view.frame.capturedAt, current.frame.capturedAt]};
          }
        }
        if (decision.kind === "complete") {
          if(report.resultKind==="communication"&&report.message?.status!=="outgoing_visible"){
            history.push({operation:null,status:"proposal_rejected",actionSubmitted:false,error:"Sending requires the bound send_message operation and a new outgoing message verified twice; draft text is not a sent message.",observedTexts:current.elements.map(e=>e.text)});
            if(++consecutiveNoAction>=3){report.status="blocked";report.error="Message submission not verified";break;}await checkpoint();continue;
          }
          if(requiresFreshAction(goal)&&!report.submissions.length){
            history.push({operation:null,status:"proposal_rejected",actionSubmitted:false,error:"User explicitly requested a fresh/repeated action. The old visible result is not completion. Execute the requested interaction and verify its new result.",observedTexts:current.elements.map(e=>e.text)});
            if(++consecutiveNoAction>=3){report.status="blocked";report.error="Repeated completion claims lacked a requested fresh action";break;}await checkpoint();continue;
          }
          if(reflex&&localHomeDecision(goal,view,report.objectives)&&!navigationLayout(current).home){report.status="blocked";report.error="Launcher layout changed before independent completion confirmation";break;}
          if(report.resultKind==="form_storage"&&!report.formStorage?.reopened){
            history.push({operation:null,status:"proposal_rejected",error:"Storage needs one verified commit, navigation away, then reopening the same saved values; do not create again",observedTexts:current.elements.map(e=>e.text)});
            if(++consecutiveNoAction>=3){report.status="blocked";report.error="Saved record has not been independently reopened";break;}
            await checkpoint();continue;
          }
          if (!report.objectives.length || report.objectives.some(o => !o.verified) || !confirmsTexts(decision.finalEvidence, view, current)) {
            report.status = "blocked"; report.error = "Completion claim lacked independent evidence for every frozen objective"; break;
          }
          report.completionEvidence = {texts: decision.finalEvidence, sequences: [view.frame.sequence, current.frame.sequence], level: report.formStorage?.reopened?"saved_record_reopened":reflex?"local_navigation":"model_selected_visual_objectives", deliveryOrStorageVerified:report.formStorage?.reopened===true};
          report.status = "observed_complete"; break;
        }
        if (report.submissions.length >= maximumActions) {report.status = "budget_exhausted"; report.error = "Physical action budget exhausted"; break;}
        const exploration = decision.step!.verification === "observe";
        const filling=decision.step!.operation==="fill_field",committing=decision.step!.operation==="commit_form";
        const sending=decision.step!.operation==="send_message";
        let request: ReturnType<typeof decisionRequest> | ReturnType<typeof explorationRequest> | ReturnType<typeof fieldRequest>;
        try {
          request = filling ? fieldRequest(decision,view) : exploration ? explorationRequest(decision,view) : decisionRequest(decision,view);
          if(options.visibleTextEntry&&current.state.keyboard){
            const label=request.intent.type==='tap_observed'?request.intent.target.text:'text' in request.intent?request.intent.text:'';
            if(/^(cut|copy|paste|select all|剪切|拷贝|复制|粘贴|全选)$/i.test(label))throw new Error('Text editing must use set_field desired-value reconciliation; direct clipboard/selection taps bypass its field-state journal');
          }
          if(sending){
            if(report.message?.submitted)throw new Error("A message submission was already attempted; no resend");
            validateMessageDraft(decision.step!.message!,goal,[view,current]);
          }
          if(request.intent.type==="tap_observed"){
            const target=observedTarget(current,request.intent.target);
            if("expect" in request&&request.expect.displayText&&regionContains(request.expect.displayText.region,target,current))throw new Error("Result region contains the pressed control; select the separate display, not the button label");
            if(report.resultKind==="form_storage"&&/^(save|done|保存|完成)$/i.test(target.text))throw new Error("Use the verified form commit for saving");
            const index=report.objectives.findIndex(o=>!o.verified);if(!statefulObjectives.has(index))statefulObjectives.set(index,current);
          }
          if(request.intent.type==="tap_region"&&!sameObservedRegion(view,current,request.intent.regionId))
            throw new Error("Observed region moved or changed during inference; inspect the new frame before choosing again");
          if(committing){
            const values=report.fieldEntries.filter(e=>e.purpose==="form"&&e.status==="verified").map(e=>e.value);
            if(report.resultKind!=="form_storage"||!values.length||report.formStorage?.committed)throw new Error("Commit requires verified form fields and permits one submission only");
            if(!valuesVisible(values,current)||!valuesVisible(values,view))throw new Error("All entered form values must be visible in two current frames before saving");
          }
          if(filling&&(!options.visibleTextEntry||report.formStorage?.committed))throw new Error("Visible input is disabled, or a committed record must be reopened instead of re-created");
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Invalid action contract";
          trace.error = `Proposal rejected before dispatch: ${detail}`;
          history.push({operation: decision.step, status: "proposal_rejected", error: detail, observedTexts: current.elements.filter(e => e.confidence >= .65).map(e => e.text).slice(0, 64)});
          if (++consecutiveNoAction >= 3) {report.status = "blocked"; report.error = "Three invalid action proposals; no further model calls"; break;}
          await checkpoint(); continue;
        }
        if (request.intent.type === "input_text" && !capabilities.inputText) {report.status = "blocked"; report.error = "Verified text entry is unavailable; experimental keyboard mapping is not promoted"; break;}
        const objectiveIndex = decision.step!.completesObjective;
        const nextObjective=report.objectives.findIndex(o=>!o.verified);
        if (objectiveIndex !== null && objectiveIndex !== nextObjective) {
          trace.error=`Step cannot skip or repeat objective completion: next unverified index is ${nextObjective}. For an earlier stateful control outcome, cite achieved.display with the actual changed value and its camera region; static button labels cannot prove it. Otherwise use completesObjective:null. No action sent.`;
          history.push({operation:decision.step,status:"proposal_rejected",error:trace.error,observedTexts:current.elements.filter(e=>e.confidence>=.65).map(e=>e.text).slice(0,64)});
          if (++consecutiveNoAction>=3) {report.status="blocked";report.error=trace.error;break;}
          await checkpoint();continue;
        }
        // An app label must not receive duplicate taps merely because a status
        // icon OCR fragment changed. Separate frozen objectives still permit
        // a user-requested later reopening; this is not an unlimited retry.
        const attempt = attemptKey(current, request.intent, nextObjective);
        const contractKey=JSON.stringify([nextObjective,intentKey(request.intent),request.require,"expect" in request?request.expect:null]);
        if(rejectedContracts.has(contractKey)){
          trace.error="This exact outcome contract already caused ZERO actions. Change the verification contract or choose another control; repeating static evidence cannot make progress.";
          history.push({operation:request.intent,status:"proposal_rejected",actionSubmitted:false,error:trace.error,observedTexts:current.elements.map(e=>e.text)});
          if(++consecutiveNoAction>=3){report.status="blocked";report.error="Repeated invalid outcome contract; no physical action sent";break;}await checkpoint();continue;
        }
        const excluded = excludedAttempts(current, nextObjective).find(previous => sameIntent(previous.intent,request.intent));
        if (attempted.has(attempt) || excluded) {
          trace.error = `Repeated action on unchanged content rejected${excluded?` (step ${excluded.step})`:""}; OCR noise is not progress. Choose a different grounded route; no action sent`;
          history.push({operation:request.intent,status:"alternative_required",error:trace.error,
            observedTexts:current.elements.filter(e=>e.confidence>=.65).map(e=>e.text).slice(0,64)});
          if (++consecutiveNoAction >= 3) {report.status="blocked";report.error=`No new grounded route after three rejected proposals. ${trace.error}`;break;}
          await checkpoint();continue;
        }
        report.phase = "acting"; await checkpoint();
        const executionAt = performance.now();
        if(request.intent.type==="fill_field") {
          const intent=request.intent;
          if(!request.require||!assessExpectation(request.require,current,current,profile).met){
            history.push({operation:intent,status:"proposal_rejected",error:"Field page preconditions changed",observedTexts:current.elements.map(e=>e.text)});
            if(++consecutiveNoAction>=3){report.status="blocked";report.error="Field preconditions could not be grounded";break;}continue;
          }
          if(report.fieldEntries.some(e=>e.status==='action_uncertain'))throw new Error("An input receipt is unresolved; no new field action");
          const index=report.fieldEntries.length;
          const submissionsBeforeField=report.submissions.length;
          const result=await this.fillField(grounded,intent.field,intent.text,signal,async entry=>{
            report.fieldEntries[index]={...structuredClone(entry),purpose:intent.purpose};await checkpoint();
          },{purpose:intent.purpose,targetRegion:intent.targetRegion,prior:report.fieldEntries.slice(0,index).findLast(e=>e.purpose===intent.purpose&&e.value===intent.text)});
          report.fieldEntries[index]={...result,purpose:intent.purpose};report.timing.executionMs+=performance.now()-executionAt;
          attempted.add(attempt);
          if(result.status!=="verified") {
            // Search is a means of finding a target. Inline completion is not
            // exact typed-text evidence, but an independent result can make
            // further typing unnecessary. Return it for a new navigation plan.
            if((result.status==='blocked'||result.status==='result_available')&&intent.purpose==='query'&&result.typing?.status!=='action_uncertain'){
              const first=await freshAfter(current);
              if(systemSearchResultTarget(first,intent.text)){
                const second=await freshAfter(first);
                if(systemSearchResultTarget(second,intent.text)){
                  report.fieldEntries[index]={...result,purpose:intent.purpose,status:'result_available'};
                  history.push({operation:intent,status:'result_available',error:'Exact requested app result is visible in two frames outside the query field. Query text itself is not verified. Open the observed result; do not refill the query.',actionSubmitted:report.submissions.length>submissionsBeforeField,observedTexts:second.elements.map(e=>e.text)});
                  consecutiveNoAction=0;await checkpoint();continue;
                }
              }
            }
            // A focus/read failure before the first key is recoverable. Give
            // the model the observed result so it can select a different field
            // or route. Never keep retrying an unchanged rejected proposal.
            const fieldSubmissions=report.submissions.length-submissionsBeforeField;
            const onlyFocus=fieldSubmissions===0||fieldSubmissions===1&&!!result.focusReceiptId;
            if(result.status==='blocked'&&!(result.typing?.keys.length)&&onlyFocus){
              const after=await freshAfter(current);
              history.push({operation:intent,status:'alternative_required',error:`No characters entered: ${result.error}. Inspect current field/keyboard and choose a corrected route.`,actionSubmitted:!!result.focusReceiptId,observedTexts:after.elements.map(e=>e.text)});
              if(++consecutiveNoAction<3){await checkpoint();continue;}
            }
            if(result.status==='blocked'&&result.recovery==='replan'&&result.resolution){
              const after=await freshAfter(current);
              history.push({operation:intent,status:'input_reconciliation_required',error:JSON.stringify({reason:result.error,resolution:result.resolution,confirmedPrefix:result.confirmedPrefix}),actionSubmitted:fieldSubmissions>0,observedTexts:after.elements.map(e=>e.text)});
              if(++consecutiveNoAction<3){await checkpoint();continue;}
            }
            report.status=result.status==="action_uncertain"?"action_uncertain":"blocked";report.error=result.error;break;
          }
          const after=await freshAfter(current);
          history.push({operation:intent,status:"verified",observedTexts:after.elements.map(e=>e.text)});consecutiveNoAction=0;await checkpoint();continue;
        }
        if(sending){const m=decision.step!.message!;report.message={recipient:m.recipient,body:m.body,status:"prepared",submitted:false,deliveryVerified:false};await checkpoint();}
        const step = await executor.run(request, {execute: true, signal, initialView: current, verificationMs: options.verificationMs ?? (sending?5000:1800), exploration,commitEffect:committing||sending,
          returnOnStableChange:!committing&&!sending&&["tap_text","open_app","navigate","swipe"].includes(request.intent.type)});
        report.timing.executionMs += performance.now() - executionAt; report.timing.verificationMs += step.timing.verificationMs;
        report.steps.push(step);if(step.outcomeContractInvalid)rejectedContracts.add(contractKey);else attempted.add(attempt);
        if(sending&&step.actionSubmissionCount){
          report.message!.submitted=true;report.message!.status=step.status==="verified"?"outgoing_visible":step.status==="action_uncertain"?"uncertain":"unverified";
          await checkpoint();
          if(step.status!=="verified"){report.status=step.status==="action_uncertain"?"action_uncertain":"blocked";report.error=step.error??"Message submitted but outgoing state not verified; never resend";break;}
          if(objectiveIndex!==null){const pair=step.verificationSamples.filter(v=>v.eligible&&v.assessment?.met).slice(-2);
            if(pair.length===2){report.objectives[objectiveIndex].verified={texts:[report.message!.recipient,report.message!.body],sequences:[pair[0].sequence,pair[1].sequence],capturedAt:[pair[0].capturedAt,pair[1].capturedAt]};
              if(report.objectives.every(o=>o.verified)){report.status="observed_complete";report.completionEvidence={texts:[report.message!.recipient,report.message!.body],sequences:[pair[0].sequence,pair[1].sequence],level:"model_selected_visual_objectives",deliveryOrStorageVerified:false};break;}}
          }
        }
        if(request.intent.type==="tap_observed"&&step.actionSubmissionCount)statefulObjectives.set(nextObjective,current);
        if(!step.outcomeContractInvalid)recordedAttempts.push({objective: nextObjective, intent: request.intent, view: current, step: report.steps.length, status: step.status, error: step.error});
        // A missing launcher target has not attempted app entry. Keep discovery
        // active so local navigation can find the labeled catalog on its next turn.
        if(report.navigationDiscovery?.status==="active"&&(step.status==="action_uncertain"||
          (request.intent.type==="open_app"?step.actionSubmissionCount>0:!step.actionSubmissionCount)))
          report.navigationDiscovery.status="returned_to_planner";
        if(exploration&&navigationLayout(current).catalogMode==="labeled_list"&&latest&&step.status==="observed") {
          const old=new Set(catalogEntries(current).map(normalize)),now=new Set(catalogEntries(latest).map(normalize));
          const overlap=[...old].filter(t=>now.has(t)).length/Math.max(old.size,now.size,1);
          stalledCatalogSwipes=old.size>=3&&overlap>=.85?stalledCatalogSwipes+1:0;
          if(stalledCatalogSwipes>=2){
            const previous=recordedAttempts.at(-1)!;
            previous.stalled=true;previous.error="Catalog did not advance after two observed swipes; choose a different grounded route";
            trace.notes=[...(trace.notes??[]),previous.error];
          }
        }else stalledCatalogSwipes=0;
        history.push({operation: request.intent, status: step.status, error: step.error, actionSubmitted:step.actionSubmissionCount>0,
          expected:"expect" in request?request.expect:undefined,beforeTexts:step.before?.text.slice(0,64),
          observedNodes:latest?buildTextDocument(latest).nodes:undefined,
          observedTexts: (step.after?.text ?? step.before?.text ?? []).slice(0, 64)});
        await checkpoint();
        if(step.status==="verified"&&objectiveIndex!==null&&"expect" in request&&request.expect.displayText){
          const display=request.expect.displayText;
          const pair=recentViews.filter(v=>step.verificationSamples.some(sample=>sample.sequence===v.frame.sequence&&sample.eligible&&sample.assessment?.met)).slice(-2);
          if(pair.length===2&&pair.every(v=>regionHasUniqueText(v,display.region,display.text))){
            report.objectives[objectiveIndex].verified={texts:[display.text],sequences:[pair[0].frame.sequence,pair[1].frame.sequence],capturedAt:[pair[0].frame.capturedAt,pair[1].frame.capturedAt]};
            if(report.objectives.every(o=>o.verified)&&report.resultKind==="visual"){
              report.status="observed_complete";report.completionEvidence={texts:[display.text],sequences:[pair[0].frame.sequence,pair[1].frame.sequence],level:"model_selected_visual_objectives",deliveryOrStorageVerified:false};break;
            }
          }
        }
        if(committing&&step.actionSubmissionCount){
          report.formStorage={values:report.fieldEntries.filter(e=>e.purpose==="form"&&e.status==="verified").map(e=>e.value),
            committed:step.receipt?.status==="completed",departed:false,reopened:false,commitSequence:step.after?.sequence??current.frame.sequence,commitSubmissionCount:report.submissions.length};
          await checkpoint();
          if(!report.formStorage.committed){report.status="action_uncertain";report.error="Save receipt is uncertain; never resubmit";break;}
        }
        if (step.status === "action_uncertain") {report.status = "action_uncertain"; report.error = step.error; break;}
        if (request.intent.type === "input_text" && step.status !== "verified" && step.actionSubmissionCount) {report.status = "blocked"; report.error = "Text entry result uncertain; no retyping or field continuation"; break;}
        if(step.status==="verified"&&objectiveIndex!==null&&"expect" in request&&(request.expect.launcher||request.expect.appTitle)) {
          const eligible=recentViews.filter(v=>v.frame.sequence>current.frame.sequence&&v.frame.capturedAt>=notBefore&&assessExpectation(request.expect,v,current,profile!).met);
          const pair=eligible.slice(-2);
          if(pair.length===2){const texts=request.expect.launcher?navigationLayout(pair[0]).homeLabels.slice(0,2):appTitleEvidence(pair[0],current,request.expect.appTitle!);
            if(confirmsTexts(texts,pair[0],pair[1])){
              report.objectives[objectiveIndex].verified={texts,sequences:[pair[0].frame.sequence,pair[1].frame.sequence],capturedAt:[pair[0].frame.capturedAt,pair[1].frame.capturedAt]};
              if(report.objectives.every(o=>o.verified)&&report.resultKind==="visual") {report.status="observed_complete";report.completionEvidence={texts,sequences:[pair[0].frame.sequence,pair[1].frame.sequence],level:reflex?"local_navigation":"model_selected_visual_objectives",deliveryOrStorageVerified:false};break;}
            }
          }
        }
        // A model may declare in advance which outcome this step proves. Once
        // the UNCHANGED full postcondition passes twice, another cloud call just
        // to restate that evidence adds no information. Never do this for a
        // failed prediction, already-visible labels or a primary business effect.
        if (step.status === "verified" && objectiveIndex !== null && "expect" in request && (request.expect.textAll?.length ?? 0) >= 2) {
          const texts = request.expect.textAll!;
          const eligible = recentViews.filter(v => v.frame.sequence > current.frame.sequence && v.frame.capturedAt >= notBefore &&
            assessExpectation(request.expect, v, current, profile!).met);
          const pair = eligible.slice(-2);
          if (pair.length === 2 && texts.some(t => !current.elements.some(e => e.confidence >= .9 && normalize(e.text) === normalize(t))) && confirmsTexts(texts, pair[0], pair[1])) {
            report.objectives[objectiveIndex].verified = {texts, sequences: [pair[0].frame.sequence, pair[1].frame.sequence], capturedAt: [pair[0].frame.capturedAt, pair[1].frame.capturedAt]};
            if (report.objectives.every(o => o.verified)&&report.resultKind==="visual") {
              report.status = "observed_complete";
              report.completionEvidence = {texts, sequences: [pair[0].frame.sequence, pair[1].frame.sequence], level: "model_selected_visual_objectives", deliveryOrStorageVerified: false};
              break;
            }
          }
        }
        consecutiveNoAction = step.actionSubmissionCount ? 0 : consecutiveNoAction + 1;
        if (consecutiveNoAction >= 3) {report.status = "blocked"; report.error = "Three decisions produced no grounded action"; break;}
        // Even unverified completed actions return to perception and planning.
        // No automatic Home, Cancel, retry tap or scripted recovery is inserted.
      }
      if (report.status === "running") {report.status = "budget_exhausted"; report.error = "Decision budget exhausted";}
    } catch (error) {
      report.status = report.submissions.some(s => s.state !== "completed") ? "action_uncertain" : signal.aborted ? "budget_exhausted" : "failed";
      report.error = error instanceof Error ? error.message : "Autonomous task failed";
    } finally {
      report.phase = "finished"; this.running = false; report.timing.totalMs = performance.now() - start; await checkpoint();
    }
    return report;
  }
}
