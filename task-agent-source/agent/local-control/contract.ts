import { z } from "zod";
import { visualSelectorSchema } from "./visual-target";
import { resultReadbackSchema } from "./result-readback";
import {cameraRegionSchema,observedTargetSchema} from "./interaction";
import {messageEffectSchema} from "./message-effect";

const text = z.string().trim().min(1).max(120);
const region = z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }).strict().refine(r => r.left < r.right && r.top < r.bottom, "Invalid region");
export const intentSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("tap_observed"),target:observedTargetSchema}).strict(),
  z.object({ type: z.literal("open_app"), text }).strict(),
  z.object({ type: z.literal("tap_region"), regionId:text }).strict(),
  z.object({ type: z.literal("dismiss_search") }).strict(),
  z.object({ type: z.literal("tap_text"), text, region: region.optional(), allowOverlay: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("long_press_text"), text, region: region.optional() }).strict(),
  z.object({ type: z.literal("tap_visual"), selector:visualSelectorSchema }).strict(),
  // Direction is the finger's movement, not the content's navigation direction.
  z.object({ type: z.literal("swipe"), direction: z.enum(["up", "down", "left", "right"]) }).strict(),
  z.object({ type: z.literal("navigate"), key: z.enum(["home", "back"]) }).strict(),
  z.object({ type: z.literal("input_text"), text }).strict(),
]);
const evidenceFields = {
  launcher: z.literal(true).optional(),
  catalogList: z.literal(true).optional(),
  appTitle: text.optional(),
  textAll: z.array(text).min(1).max(20).optional(),
  textAbsent: z.array(text).min(1).max(20).optional(),
  textAt: z.array(z.object({ text, region }).strict()).min(1).max(20).optional(),
  page: z.enum(["home", "clock", "search", "content_feed", "conversation", "conversation_list", "profile", "settings"]).optional(),
  keyboard: z.boolean().optional(),
  overlay: z.enum(["none", "comments", "dialog"]).optional(),
  movedText: z.object({ text, direction: z.enum(["up", "down", "left", "right"]), minimumScreenFraction: z.number().min(0.02).max(0.8).default(0.08) }).strict().optional(),
  accentText:z.array(text).min(1).max(8).optional(),
};
const evidenceSchema = z.object(evidenceFields).strict();
export type VisualEvidence = z.infer<typeof evidenceSchema>;
const hasPositiveEvidence = (e: VisualEvidence) => Boolean(e.catalogList || e.launcher || e.appTitle || e.textAll || e.textAt || e.page || e.keyboard === true || e.movedText || e.accentText);
const positiveEvidenceSchema = evidenceSchema.refine(hasPositiveEvidence, "Each alternative needs positive visual evidence; absence alone cannot prove success");
export const expectationSchema = z.object({
  message:messageEffectSchema.optional(),
  displayText:z.object({text,region:cameraRegionSchema}).strict().optional(),
  ...evidenceFields,
  // Root conditions are mandatory. Each alternative is a complete, explicitly
  // selected evidence bundle; never turn a failed required condition into a hint.
  anyOf: z.array(positiveEvidenceSchema).min(1).max(8).optional(),
  supportingText: z.array(text).min(1).max(20).optional(),
  changedRegion:z.enum(["left_of_target","right_of_target"]).optional(),
  readback: resultReadbackSchema.optional(),
}).strict().refine(e => hasPositiveEvidence(e) || Boolean(e.anyOf) || Boolean(e.displayText) || Boolean(e.message), "A positive visual postcondition is required; hints/absence/change alone cannot prove success");
export const requestSchema = z.object({ intent: intentSchema, expect: expectationSchema,require:positiveEvidenceSchema.optional() }).strict()
  .refine(r=>r.intent.type!=="tap_visual"||((r.require?.textAll?.length??0)>=2&&r.require?.overlay==="none"),"Visual actions need two explicit current text anchors and no overlay")
  .refine(r=>r.intent.type!=="tap_region"||((r.require?.textAll?.length??0)>=2&&r.require?.overlay==="none"&&r.expect.overlay==="none"&&(r.expect.launcher===true&&r.expect.keyboard===false||(r.expect.textAll?.length??0)>=2)),"Region taps need current anchors and a positive destination contract")
  .refine(r=>r.intent.type!=="dismiss_search"||(r.expect.launcher===true&&r.expect.keyboard===false&&r.expect.overlay==="none"&&(r.require?.textAll?.length??0)>=2&&r.require?.overlay==="none"),"Search dismissal needs current anchors and independent launcher verification")
  .refine(r=>!r.expect.changedRegion||r.intent.type==="tap_visual","Image-change verification requires a visually bounded target");
export type LocalIntent = z.infer<typeof intentSchema>;
export type VisualExpectation = z.infer<typeof expectationSchema>;
export type LocalRequest = z.infer<typeof requestSchema>;

// Exploration observes a swipe's result; it cannot certify a destination or an
// objective. Keep it separate from the strict outcome contract above.
export const explorationRequestSchema = z.object({
  intent: z.union([z.object({type:z.literal("swipe"),direction:z.enum(["up","down","left","right"])}).strict(),
    z.object({type:z.literal("tap_observed"),target:observedTargetSchema}).strict()]),
  require: z.object({textAll:z.array(text).min(2).max(6),overlay:z.literal("none")}).strict(),
}).strict();
export type ExplorationRequest = z.infer<typeof explorationRequestSchema>;
