import { randomUUID } from "node:crypto";
import { LocalClosedLoopExecutor, calibrationFingerprint, type ControlDependencies, type StepReport } from "./executor";
import { extractVisualFeatures } from "./visual-target";
import { type TextTaskPlanner, type TaskPlan } from "./task-planner";
import { validateGeometry } from "./geometry";
import { requireFreshFrame } from "../local-perception/service";
import type { ResponseHint } from "./result-history";

export type TaskReport={id:string;goal:string;status:"preview"|"verified"|"blocked"|"unverified"|"action_uncertain";
  modelCalls:number;imageUploads:0;terminalInterventions:0;plan?:TaskPlan;steps:StepReport[];cleanup?:StepReport;error?:string;
  resultEvidence?:{level:"ui_response_only"|"displayed_value_change"|"visual_postconditions"|"not_confirmed";storageVerified:false};
  responseHints?:ResponseHint[];
  timing:{initialObservationMs:number;planningMs:number;executionMs:number;totalMs:number};};

export class LocalVisualTaskRunner {
  private running=false;
  constructor(private deps:ControlDependencies,private planner:Pick<TextTaskPlanner,"plan">){}
  async run(goal:string,options:{execute:boolean;signal:AbortSignal;checkpoint?:(report:TaskReport)=>Promise<void>}):Promise<TaskReport> {
    if(this.running)throw new Error("A task is already running");this.running=true;
    const start=performance.now();const report:TaskReport={id:randomUUID(),goal,status:"blocked",modelCalls:0,imageUploads:0,terminalInterventions:0,steps:[],
      timing:{initialObservationMs:0,planningMs:0,executionMs:0,totalMs:0}};
    const executor=new LocalClosedLoopExecutor(this.deps);const checkpoint=async()=>{report.timing.totalMs=performance.now()-start;await options.checkpoint?.(report);};
    let cancelledDialog=false;
    try {
      options.signal.throwIfAborted();const t0=performance.now();
      const [profile,initial]=await Promise.all([this.deps.getCalibration(options.signal),this.deps.observe(options.signal)]);
      if(!profile)throw new Error("No verified calibration");
      validateGeometry(profile,initial);requireFreshFrame(initial.frame.capturedAt);
      if(initial.deviceId!==this.deps.deviceId||initial.timing.ocrCacheHit||initial.timing.ocrCapturedAt!==initial.frame.capturedAt)throw new Error("Task planning requires fresh device-matched OCR");
      initial.visual??=await extractVisualFeatures(initial,profile);report.timing.initialObservationMs=performance.now()-t0;
      const t1=performance.now();report.modelCalls=1;
      let planned:Awaited<ReturnType<TextTaskPlanner["plan"]>>;
      try{planned=await this.planner.plan(goal,initial,options.signal,{calibrationFingerprint:calibrationFingerprint(profile)});}finally{report.timing.planningMs=performance.now()-t1;}
      report.plan=planned.plan;report.responseHints=planned.responseHints??[];await checkpoint();
      if(planned.plan.unsupportedReason)throw new Error(planned.plan.unsupportedReason);
      if(!options.execute){report.status="preview";return report;}
      const executionStart=performance.now();
      try {
        for(const step of planned.plan.steps) {
          options.signal.throwIfAborted();
          let scene=await this.deps.observe(options.signal);
          if(scene.state.overlay==="dialog") {
            const cancel=scene.elements.filter(e=>e.confidence>=.8&&/^(cancel|取消)$/i.test(e.text.trim()));
            if(cancelledDialog||cancel.length!==1)throw new Error("Unexpected dialog without one unambiguous cancellation control");
            const recovery=await executor.run({intent:{type:"tap_text",text:cancel[0].text,allowOverlay:true},
              expect:{...step.require,overlay:"none",textAbsent:[cancel[0].text]}},{execute:true,signal:options.signal});
            report.steps.push(recovery);cancelledDialog=true;await checkpoint();
            if(recovery.status!=="verified")throw new Error("Dialog cancellation was not verified");
            scene=await this.deps.observe(options.signal);
          }
          const outcome=await executor.run(step,{execute:true,signal:options.signal,initialView:scene});report.steps.push(outcome);await checkpoint();
          if(!["verified","already_satisfied"].includes(outcome.status)) {
            report.status=outcome.status==="action_uncertain"?"action_uncertain":"unverified";
            // A completed-but-unverified action is never repeated. Honor an
            // explicitly planned final Home as cleanup, without calling it success.
            const last=planned.plan.steps.at(-1);
            if(outcome.status!=="action_uncertain"&&report.steps.some(s=>s.receipt?.status==="completed")&&last!==step&&last?.intent.type==="navigate"&&last.intent.key==="home") {
              report.cleanup=await executor.run(last,{execute:true,signal:options.signal});await checkpoint();
            }
            throw new Error(outcome.error??"Step was not verified");
          }
        }
        report.status="verified";
      } finally{report.timing.executionMs=performance.now()-executionStart;}
    }catch(error){
      if(report.status==="blocked"&&report.steps.some(s=>s.actionSubmissionCount>0))report.status=report.steps.some(s=>s.status==="action_uncertain")?"action_uncertain":"unverified";
      report.error=error instanceof Error?error.message:String(error);
    }
    finally{
      const readbacks=report.steps.flatMap(step=>step.after?.readback?[step.after.readback]:[]);
      report.resultEvidence={level:report.status!=="verified"?"not_confirmed":readbacks.some(r=>r.level==="ui_response")?"ui_response_only"
        :readbacks.some(r=>r.level==="displayed_value_change")?"displayed_value_change":"visual_postconditions",storageVerified:false};
      report.timing.totalMs=performance.now()-start;this.running=false;await options.checkpoint?.(report);
    }
    return report;
  }
}
