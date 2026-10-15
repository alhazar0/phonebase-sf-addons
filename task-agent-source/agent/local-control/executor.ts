import {detectObservedRegions,currentObservedRegion,type ObservedRegion} from "./observed-regions";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ScreenHandSemanticAction } from "../action-contract";
import { calibratedScreenPoint, type ScreenHandCalibrationProfile } from "../calibration-profile";
import type { AgentActionResult, AgentDevice } from "../general-agent-client";
import type { Point } from "../homography";
import type { PerceptionSnapshot } from "../local-perception/service";
import { requireFreshFrame } from "../local-perception/service";
import { explorationRequestSchema, requestSchema, type LocalIntent, type VisualEvidence, type VisualExpectation } from "./contract";
import { extractVisualFeatures, selectVisualTarget, type VisualFeatures, type VisualTarget } from "./visual-target";
import { prepareImageProof, type ImageProof } from "./image-proof";
import { prepareResultReadback, type ReadbackEvidence } from "./result-readback";
import type { VisualAffordance } from "../visual-affordance-detector";
import { cameraToScreen, validateGeometry } from "./geometry";
import type { RecentAction } from "../local-perception/action-context";
import {navigationLayout,appTitleEvidence,catalogEntries,launcherIconTarget,catalogIconTarget} from "./navigation-grounding";
import {canonicalLabel} from "./text-label";
import {normalTouchPressure} from "./touch-policy";
import {currentAppIcon,type BoundAppIcon} from "./icon-library";
import {currentSearchBackdrop,detectSearchBackdrop,systemSearchEvidence,systemSearchResultsEvidence,systemSearchResultTarget,type SearchBackdrop} from "./search-dismissal";
import {observedKeyboardTop,observedTarget,readRegion,regionHasUniqueText} from "./interaction";
import {assessMessageResult} from "./message-effect";
export { cameraToScreen, validateGeometry } from "./geometry";

export type LocalView = Pick<PerceptionSnapshot, "deviceId" | "frame" | "state" | "elements"> & {timing:Omit<PerceptionSnapshot["timing"],"visualMs"> & {visualMs?:number};affordances?:VisualAffordance[];visual?:VisualFeatures;regions?:ObservedRegion[];searchBackdrop?:SearchBackdrop|null;appIcons?:BoundAppIcon[];imageProof?:ImageProof;readback?:ReadbackEvidence;recentActions?:RecentAction[]};
export type ControlDependencies = {
  deviceId: string;
  observe: (signal: AbortSignal) => Promise<LocalView>;
  getDevice: (signal: AbortSignal) => Promise<AgentDevice>;
  getCalibration: (signal: AbortSignal) => Promise<ScreenHandCalibrationProfile | null>;
  act: (action: ScreenHandSemanticAction, signal: AbortSignal, key: string) => Promise<AgentActionResult>;
};
const normalize = canonicalLabel;
export const calibrationFingerprint = (profile: ScreenHandCalibrationProfile) => createHash("sha256").update(JSON.stringify(profile)).digest("hex");
export type StepReport = {
  id: string; deviceId: string; startedAt: string; status: "preview" | "already_satisfied" | "verified" | "observed" | "blocked" | "unverified" | "action_uncertain";
  verificationMode?: "destination" | "observe";
  outcomeContractInvalid?:boolean;
  request: unknown; error?: string; calibrationId?: string; calibrationFingerprint?: string;
  action?: ScreenHandSemanticAction; actionSubmissionCount: number; receipt?: AgentActionResult["receipt"];
  visualTarget?:VisualTarget;
  before?: ReturnType<typeof evidence>; after?: ReturnType<typeof evidence>;
  verificationSamples: Array<ReturnType<typeof evidence> & { assessment?: ExpectationAssessment; eligible?: boolean }>;
  verification?: ExpectationAssessment;
  timing: { setupMs: number; observationMs: number; fetchMs: number; ocrMs: number; selectionMs: number; calibrationRecheckMs: number; actionMs: number; verificationMs: number; totalMs: number };
  generativeModelCalls: 0;
};
function evidence(view: LocalView) {
  return { sequence: view.frame.sequence, capturedAt: view.frame.capturedAt, page: view.state.page, overlay: view.state.overlay, keyboard: view.state.keyboard,
    ocrCapturedAt: view.timing.ocrCapturedAt, ocrCacheHit: view.timing.ocrCacheHit, text: view.elements.filter(e => e.confidence >= 0.65).map(e => e.text), timing: view.timing,
    visual:view.visual,regions:view.regions,searchBackdrop:view.searchBackdrop,appIcons:view.appIcons,imageProof:view.imageProof,readback:view.readback,recentActions:view.recentActions };
}

function matching(view: LocalView, text: string) { return view.elements.filter(e => e.confidence >= 0.65 && normalize(e.text) === normalize(text)); }

type EvidenceCheck = { condition: string; met: boolean };
export type ExpectationAssessment = {
  met: boolean;
  checks: EvidenceCheck[];
  alternatives: Array<{ index: number; met: boolean; checks: EvidenceCheck[] }>;
  matchedAlternatives: number[];
  supportingText: Array<{ text: string; present: boolean }>;
};

function checkEvidence(expect: VisualEvidence, view: LocalView, before: LocalView, profile: ScreenHandCalibrationProfile): EvidenceCheck[] {
  const checks: EvidenceCheck[] = [];
  if(expect.catalogList)checks.push({condition:"labeled app catalog is open",met:catalogEntries(view).length>=2});
  if(expect.launcher)checks.push({condition:"independent launcher grid and search control",met:navigationLayout(view).home});
  if(expect.appTitle)checks.push({condition:`new application title and content: ${expect.appTitle}`,met:appTitleEvidence(view,before,expect.appTitle).length>=2});
  for(const text of expect.accentText??[])checks.push({condition:`yellow accent text: ${text}`,met:(view.visual?.accentText??[]).some(t=>normalize(t)===normalize(text))});
  for (const text of expect.textAll ?? []) checks.push({ condition: `text present: ${text}`, met: matching(view,text).length > 0 });
  for (const text of expect.textAbsent ?? []) checks.push({ condition: `text absent: ${text}`, met: matching(view,text).length === 0 });
  for (const {text,region} of expect.textAt ?? []) {
    const met = matching(view,text).some(element => {
      try {
        const point = cameraToScreen(profile,element.center);
        return point.x/profile.screen.width >= region.left && point.x/profile.screen.width <= region.right &&
          point.y/profile.screen.height >= region.top && point.y/profile.screen.height <= region.bottom;
      } catch { return false; }
    });
    checks.push({condition:`text in screen region ${JSON.stringify(region)}: ${text}`,met});
  }
  if (expect.page) checks.push({condition:`current page: ${expect.page}`,met:view.state.page === expect.page && view.state.source === "current_evidence"});
  if (expect.keyboard !== undefined) checks.push({condition:`keyboard: ${expect.keyboard}`,met:view.state.keyboard === expect.keyboard});
  if (expect.overlay !== undefined) checks.push({condition:`overlay: ${expect.overlay}`,met:view.state.overlay === expect.overlay});
  if (expect.movedText) {
    const a = matching(before, expect.movedText.text); const b = matching(view, expect.movedText.text);
    let met = false;
    if (a.length === 1 && b.length === 1) {
      try {
        const old = cameraToScreen(profile, a[0].center); const next = cameraToScreen(profile, b[0].center);
        const direction = expect.movedText.direction;
        const distance = direction === "up" ? (old.y-next.y)/profile.screen.height : direction === "down" ? (next.y-old.y)/profile.screen.height : direction === "left" ? (old.x-next.x)/profile.screen.width : (next.x-old.x)/profile.screen.width;
        met = distance >= expect.movedText.minimumScreenFraction;
      } catch { /* An unmappable text box is not movement evidence. */ }
    }
    checks.push({condition:`text moved ${expect.movedText.direction}: ${expect.movedText.text}`,met});
  }
  return checks;
}

export function assessExpectation(expect: VisualExpectation, view: LocalView, before: LocalView, profile: ScreenHandCalibrationProfile): ExpectationAssessment {
  const checks = checkEvidence(expect,view,before,profile);
  if(expect.message)checks.push({condition:"new outgoing message in the bound conversation; not a delivery receipt",met:assessMessageResult(expect.message,view).met});
  if(expect.displayText){const {text,region}=expect.displayText,old=readRegion(before,region);
    checks.push({condition:`display region changed from ${old} to ${text}`,met:regionHasUniqueText(view,region,text)&&!regionHasUniqueText(before,region,text)});}
  if(expect.changedRegion)checks.push({condition:`stable visual change ${expect.changedRegion}`,met:view.imageProof?.met===true});
  if(expect.readback)checks.push({condition:`result read-back ${expect.readback.kind}: ${expect.readback.label}`,met:view.readback?.met===true&&view.readback.kind===expect.readback.kind&&normalize(view.readback.label)===normalize(expect.readback.label)});
  // Unexpected overlays cannot be ignored just because background text survives.
  // A requested overlay must be explicit in the root or the matching bundle.
  const alternatives = (expect.anyOf ?? []).map((branch,index) => {
    const branchChecks = checkEvidence(branch,view,before,profile);
    if (expect.overlay === undefined && branch.overlay === undefined) branchChecks.push({condition:"no unexpected overlay",met:view.state.overlay === "none"});
    return {index,met:branchChecks.every(c=>c.met),checks:branchChecks};
  });
  if (!alternatives.length && expect.overlay === undefined) checks.push({condition:"no unexpected overlay",met:view.state.overlay === "none"});
  const matchedAlternatives = alternatives.filter(a=>a.met).map(a=>a.index);
  return {met:checks.every(c=>c.met) && (!alternatives.length || matchedAlternatives.length > 0),checks,alternatives,matchedAlternatives,
    supportingText:(expect.supportingText ?? []).map(text=>({text,present:matching(view,text).length > 0}))};
}

export function expectationMet(expect: VisualExpectation, view: LocalView, before: LocalView, profile: ScreenHandCalibrationProfile): boolean {
  return assessExpectation(expect,view,before,profile).met;
}

export function selectAction(intent: LocalIntent, view: LocalView, profile: ScreenHandCalibrationProfile): ScreenHandSemanticAction {
  validateGeometry(profile, view);
  if (view.state.overlay !== "none" && intent.type !== "navigate" && !(intent.type === "tap_text" && intent.allowOverlay)) throw new Error("Unexpected overlay; no action selected behind it");
  const viewport = profile.screen;
  const context = { viewport, frameSequence: view.frame.sequence };
  if(intent.type==="tap_observed"){
    if(view.state.keyboard&&intent.target.region.bottom*view.frame.height>observedKeyboardTop(view))throw new Error("Observed-control taps do not bypass verified keyboard input");
    if(navigationLayout(view).home||navigationLayout(view).catalog)throw new Error("Use grounded app navigation for launcher and catalog labels");
    const element=observedTarget(view,intent.target),point=cameraToScreen(profile,element.center);calibratedScreenPoint(profile,point);
    return {type:"tap",point,...context,durationMs:profile.tap.dwellMs};
  }
  if(intent.type==="tap_region"){
    const target=currentObservedRegion(view,intent.regionId),point=cameraToScreen(profile,target.center);calibratedScreenPoint(profile,point);
    return {type:"tap",point,...context,durationMs:profile.tap.dwellMs};
  }
  if(intent.type==="dismiss_search"){
    const target=currentSearchBackdrop(view),point=cameraToScreen(profile,target.center);calibratedScreenPoint(profile,point);
    return {type:"tap",point,...context,durationMs:profile.tap.dwellMs};
  }
  if(intent.type==="open_app") {
    const layout=navigationLayout(view);
    if(!layout.home&&!layout.catalog&&!systemSearchEvidence(view)&&!systemSearchResultsEvidence(view))throw new Error("open_app requires a currently observed launcher, labeled app catalog or system-search suggestions");
    if(systemSearchResultsEvidence(view)&&!systemSearchResultTarget(view,intent.text))throw new Error('Open app requires a unique observed search result outside the query field');
    const icon=layout.categoryGrid?currentAppIcon(view,intent.text,calibrationFingerprint(profile)):null;
    if(icon){
      const point=cameraToScreen(profile,icon.center);calibratedScreenPoint(profile,point);
      return {type:"tap",point,...context,durationMs:profile.tap.dwellMs};
    }
    return selectAction({type:"tap_text",text:intent.text},view,profile);
  }
  if(intent.type==="tap_visual") {
    const target=selectVisualTarget(intent.selector,view,profile);
    const point=cameraToScreen(profile,target.center);calibratedScreenPoint(profile,point);
    return {type:"tap",point,...context,durationMs:profile.tap.dwellMs};
  }
  if (intent.type === "tap_text" || intent.type === "long_press_text") {
    const layout=navigationLayout(view);
    if(layout.catalogMode==="labeled_list"&&normalize(intent.text)===normalize(layout.catalogSearchText??""))
      throw new Error("The labeled app list is already open; do not reset it by tapping search again. Scroll the current list or open the visible app.");
    if(navigationLayout(view).nonInteractiveCaptions.some(t=>normalize(t)===normalize(intent.text)))
      throw new Error("This is a category caption, not an app button. Open the observed catalog search field to reveal labeled apps; tapping it does not require typing.");
    const gridTarget=layout.home&&!/^(search|搜索)$/.test(normalize(intent.text));
    const icon=gridTarget?launcherIconTarget(view,intent.text):catalogIconTarget(view,intent.text);
    if(gridTarget&&!icon)throw new Error("No unique visible icon can be bound to this launcher label; use the labeled catalog instead of tapping its caption");
    const targets = matching(view, intent.text).flatMap(e => {
      let point: Point;
      try { point = cameraToScreen(profile, icon?.center??e.center); } catch { return []; }
      const r = intent.region;
      if (r && (point.x/viewport.width < r.left || point.x/viewport.width > r.right || point.y/viewport.height < r.top || point.y/viewport.height > r.bottom)) return [];
      return [{point}];
    });
    if (targets.length !== 1) throw new Error(`Expected one visible target "${intent.text}"; found ${targets.length}. No fuzzy or remembered-coordinate click allowed.`);
    calibratedScreenPoint(profile, targets[0].point);
    return intent.type==="long_press_text"?{ type:"long_press", point:targets[0].point, ...context, durationMs:850 }:{ type:"tap", point:targets[0].point, ...context, durationMs:profile.tap.dwellMs };
  }
  if (intent.type === "swipe") {
    // Scroll the content above an observed keyboard, never swipe across its keys.
    const lower=view.state.keyboard?0.50:0.74,middle=view.state.keyboard?0.4:0.5;
    const points = { up:[0.5,lower,0.5,0.3], down:[0.5,0.3,0.5,lower], left:[0.85,middle,0.15,middle], right:[0.15,middle,0.85,middle] }[intent.direction];
    const start = {x:points[0]*viewport.width,y:points[1]*viewport.height}; const end = {x:points[2]*viewport.width,y:points[3]*viewport.height};
    calibratedScreenPoint(profile,start); calibratedScreenPoint(profile,end);
    return {type:"swipe",start,end,...context,durationMs:300};
  }
  if (intent.type === "navigate") {
    // Home is placement-specific and delegated to the existing calibrated driver.
    if (intent.key === "home" && !profile.navigation?.home) throw new Error("No calibrated Home strategy for this phone");
    if (intent.key === "back") {
      // Do not inherit a fixed-edge iOS gesture on arbitrary phones.
      const targets = view.elements.filter(e => /^(back|返回|cancel|取消)$/i.test(normalize(e.text)) && e.confidence >= 0.65).filter(e => cameraToScreen(profile,e.center).y < viewport.height*0.22);
      if (targets.length !== 1) throw new Error("Back requires one visible Back/Cancel text control in this baseline");
      return selectAction({type:"tap_text",text:targets[0].text,region:{left:0,top:0,right:1,bottom:0.22},allowOverlay:true},view,profile);
    }
    return {type:"phone_key",key:"home"};
  }
  if (!view.state.keyboard || profile.keyboard?.strict !== true) throw new Error("Text entry needs a visible keyboard and a verified physical keyboard profile");
  return {type:"input_text",text:intent.text};
}

export class LocalClosedLoopExecutor {
  private running = false;
  constructor(private deps: ControlDependencies) {}

  async run(input: unknown, options: { execute?: boolean; signal?: AbortSignal; verificationMs?: number; initialView?: LocalView; exploration?: boolean;
    // Only the host's field-verified commit path may request this. It does not
    // relax postconditions or make existing form text persistence evidence.
    commitEffect?:boolean;returnOnStableChange?:boolean } = {}): Promise<StepReport> {
    if (this.running) throw new Error("An action is already running; concurrent movement is not allowed");
    this.running = true;
    const started = performance.now();
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    const report: StepReport = {id:randomUUID(),deviceId:this.deps.deviceId,startedAt:new Date().toISOString(),status:"blocked",request:input,actionSubmissionCount:0,verificationSamples:[],generativeModelCalls:0,
      timing:{setupMs:0,observationMs:0,fetchMs:0,ocrMs:0,selectionMs:0,calibrationRecheckMs:0,actionMs:0,verificationMs:0,totalMs:0}};
    try {
      const request = options.exploration ? {...explorationRequestSchema.parse(input),expect:undefined} : requestSchema.parse(input);
      report.verificationMode = options.exploration ? "observe" : "destination";
      const budget=options.verificationMs ?? (request.expect?.readback ? 2_500 : 6_000);
      if (!Number.isFinite(budget) || budget<100 || budget>15_000) throw new Error("Invalid verification timeout");
      signal.throwIfAborted();
      const t0 = performance.now();
      const [device, profile] = await Promise.all([this.deps.getDevice(signal),this.deps.getCalibration(signal)]);
      report.timing.setupMs = performance.now()-t0;
      if (device.id !== this.deps.deviceId || !device.connected || !profile) throw new Error("Connected device and verified calibration are required");
      report.calibrationId = profile.id; report.calibrationFingerprint = calibrationFingerprint(profile);
      const requirements:VisualEvidence|undefined=request.require;
      const needsVisual=request.intent.type==="tap_visual"||Boolean(requirements?.accentText||request.expect?.accentText||request.expect?.anyOf?.some(e=>e.accentText));
      const observe=async(s:AbortSignal)=>{
        for(let attempt=0;;attempt++)try {
          const v=await this.deps.observe(s);if(needsVisual&&!v.visual)v.visual=await extractVisualFeatures(v,profile);return v;
        }catch(error){
          if(s.aborted||attempt>=2||!(error instanceof Error)||!error.message.startsWith("Camera frame is stale or its clock is invalid"))throw error;
          // Cold OCR can consume this frame's TTL. Fetch a NEW frame; never
          // increase its lifetime or repeat a physical submission.
          await delay(80,undefined,{signal:s});
        }
      };
      const t1 = performance.now(); const before = options.initialView ?? await observe(signal);
      if(needsVisual&&!before.visual)before.visual=await extractVisualFeatures(before,profile);
      if(request.intent.type==="tap_region")before.regions=await detectObservedRegions(before);
      if(request.intent.type==="dismiss_search")before.searchBackdrop=await detectSearchBackdrop(before);
      // Evidence generated for a previous action is never reusable as a result.
      delete before.readback; delete before.imageProof;
      report.timing.observationMs = performance.now()-t1;
      if (before.deviceId !== device.id) throw new Error("Observation belongs to another device");
      requireFreshFrame(before.frame.capturedAt); validateGeometry(profile,before);
      if (before.timing.ocrCacheHit || before.timing.ocrCapturedAt !== before.frame.capturedAt) throw new Error("Target selection requires fresh OCR from the current frame");
      report.timing.fetchMs = before.timing.fetchMs; report.timing.ocrMs = before.timing.ocrMs; report.before = evidence(before);
      if (request.expect) {
        if(request.expect.displayText&&regionHasUniqueText(before,request.expect.displayText.region,request.expect.displayText.text)){report.outcomeContractInvalid=true;throw new Error("Predicted display value already exists; no action sent. Specify the actual expected change, not an existing value");}
        report.verification=assessExpectation(request.expect,before,before,profile);
        if (report.verification.met&&!options.commitEffect) { report.status="already_satisfied"; report.outcomeContractInvalid=true; report.error="No action was submitted: predicted result already exists BEFORE the tap. Existing controls are not evidence of an input or state change. Select a result region and a changed value, or explicitly observe a reversible control interaction."; return report; }
      }
      // Preconditions describe the CURRENT page. Explicit navigation/overlay
      // actions may start in its observed dialog; the destination contract must
      // still prove the dialog is gone. Do not apply the postcondition's default
      // no-overlay policy to an explicitly permitted current-overlay action.
      const canLeaveOverlay=request.intent.type==="navigate"||request.intent.type==="tap_text"&&request.intent.allowOverlay===true;
      const precondition=request.require&&canLeaveOverlay&&request.require.overlay===undefined?{...request.require,overlay:before.state.overlay}:request.require;
      if(precondition&&!assessExpectation(precondition,before,before,profile).met){report.outcomeContractInvalid=true;throw new Error("Current visual preconditions are not met; no action sent. Inspect actual OCR and revise the page anchors");}
      if(options.commitEffect&&request.intent.type!=="tap_text"&&!(request.expect?.message&&request.intent.type==="tap_observed"))throw new Error("A commit needs an explicit bound text control or message contract");
      const t2 = performance.now(); report.action = normalTouchPressure(selectAction(request.intent,before,profile),device); report.timing.selectionMs = performance.now()-t2;
      if(request.intent.type==="tap_visual")report.visualTarget=selectVisualTarget(request.intent.selector,before,profile);
      const imageProof=request.expect?.changedRegion&&report.visualTarget?await prepareImageProof(before,report.visualTarget,request.expect.changedRegion,profile):undefined;
      const readback=request.expect?.readback?prepareResultReadback(request.expect.readback,before):undefined;
      if (!options.execute) { report.status="preview"; return report; }
      const t3 = performance.now();
      const [current, currentProfile] = await Promise.all([this.deps.getDevice(signal),this.deps.getCalibration(signal)]);
      report.timing.calibrationRecheckMs=performance.now()-t3;
      if (current.id !== device.id || !current.connected || !current.state?.grbl?.homed || current.state.grbl.state !== "Idle" || current.state.grbl.activeOperation || current.state.grbl.liveTouch) throw new Error("Device is not homed, idle and free of other operations");
      if (!currentProfile || calibrationFingerprint(currentProfile) !== report.calibrationFingerprint) throw new Error("Calibration changed during planning");
      if (!current.capabilities.actions[report.action.type]?.available) throw new Error(current.capabilities.actions[report.action.type]?.reason ?? "Action is unavailable");
      requireFreshFrame(before.frame.capturedAt); signal.throwIfAborted();
      report.actionSubmissionCount=1; report.status="action_uncertain";
      const t4 = performance.now();
      let result: AgentActionResult;
      try { result = await this.deps.act(report.action,signal,`local-loop-${report.id}`); } finally {report.timing.actionMs=performance.now()-t4;}
      report.receipt=result.receipt;
      if (result.receipt.status !== "completed") throw new Error("Action did not return a completed receipt; never resubmit blindly");
      report.status="unverified";
      // Upload timestamps are not exposure timestamps. Add a small pipeline guard,
      // then require two independent uncached post-action observations.
      const notBefore = Date.now()+120; const verificationStart=performance.now();
      const verifySignal=AbortSignal.any([signal,AbortSignal.timeout(budget)]);
      let previousSequence=before.frame.sequence; let previousCapturedAt=before.frame.capturedAt; let confirmed=0;
      let previousAlternatives: number[] = [];
      let mismatchSignature="",stableMismatch=0;
      const signature=(v:LocalView)=>v.elements.filter(e=>e.confidence>=.65&&!/^[\d\s:%.+°]+$/.test(e.text)).map(e=>normalize(e.text)).sort();
      const beforeSignature=new Set(signature(before));
      try {
        while (performance.now()-verificationStart < budget) {
          await delay(90,undefined,{signal:verifySignal});
          const after=await observe(verifySignal); verifySignal.throwIfAborted();
          validateGeometry(profile,after); requireFreshFrame(after.frame.capturedAt);
          if (after.deviceId !== device.id) throw new Error("Verification belongs to another device");
          if (after.frame.sequence < previousSequence || after.frame.capturedAt < previousCapturedAt) throw new Error("Camera stream restarted during action verification");
          if (after.frame.sequence === previousSequence || after.frame.capturedAt === previousCapturedAt) continue;
          previousSequence=after.frame.sequence; previousCapturedAt=after.frame.capturedAt;
          const eligible=after.frame.capturedAt >= notBefore && !after.timing.ocrCacheHit && after.timing.ocrCapturedAt === after.frame.capturedAt;
          delete after.readback; delete after.imageProof;
          if(eligible&&imageProof)after.imageProof=await imageProof(after);
          if(eligible&&readback)after.readback=readback(after);
          if (!request.expect) {
            // Two independent fresh observations record what actually happened,
            // including unchanged screens or popups. Neither is goal success.
            report.verificationSamples.push({...evidence(after),eligible});
            confirmed=eligible ? confirmed+1 : 0;
            if (eligible) report.after=evidence(after);
            if (confirmed>=2) {report.status="observed";return report;}
            continue;
          }
          const assessment=assessExpectation(request.expect,after,before,profile);
          report.verificationSamples.push({...evidence(after),assessment,eligible});
          if (!eligible) {confirmed=0;previousAlternatives=[];continue;}
          report.verification=assessment;
          const currentAlternatives=assessment.alternatives.length ? assessment.matchedAlternatives : [-1];
          const consistent=previousAlternatives.some(index=>currentAlternatives.includes(index));
          confirmed=assessment.met ? (consistent ? confirmed+1 : 1) : 0;
          previousAlternatives=assessment.met ? currentAlternatives : [];
          report.after=evidence(after);
          if (confirmed>=2) {report.status="verified";return report;}
          // Stable changed content is evidence for replanning, not goal success.
          if(options.returnOnStableChange&&!options.commitEffect&&!assessment.met) {
            const words=signature(after),key=words.join("\n"),changed=words.filter(t=>!beforeSignature.has(t)).length>=2;
            stableMismatch=changed&&key===mismatchSignature?stableMismatch+1:changed?1:0;mismatchSignature=key;
            if(stableMismatch>=2){report.error="Actual page changed but did not match predicted labels; returned fresh evidence without waiting for timeout or repeating the action";return report;}
          }
        }
        throw new Error("Expected UI was not independently verified twice; no retry action sent");
      } catch(error) {
        if (verifySignal.aborted && !signal.aborted) throw new Error("Visual verification timed out: command completed but the expected UI was not confirmed; no retry action sent", {cause:error});
        throw error;
      } finally {report.timing.verificationMs=performance.now()-verificationStart;}
    } catch(error) {report.error=error instanceof Error?error.message:String(error); return report;}
    finally {report.timing.totalMs=performance.now()-started;this.running=false;}
  }
}
