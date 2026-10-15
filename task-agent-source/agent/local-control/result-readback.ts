import { z } from "zod";
import type { LocalView } from "./executor";

const label = z.string().trim().min(1).max(120);
export const resultReadbackSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new_text"), label }).strict(),
  z.object({ kind: z.literal("counter_delta"), label, delta: z.number().int().min(-100).max(100).refine(n => n !== 0) }).strict(),
]);
export type ResultReadback = z.infer<typeof resultReadbackSchema>;
export type ReadbackEvidence = {
  kind: ResultReadback["kind"];
  label: string;
  level: "ui_response" | "displayed_value_change";
  met: boolean;
  before: string | number | null;
  after: string | number | null;
  reason: "matched" | "missing_or_ambiguous" | "unchanged" | "unexpected_delta" | "layout_changed";
  storageVerified: false;
};
const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");

// Intentionally reject rounded counts (1.2K), dates, signs and ambiguous locale
// separators. Exact deltas must not be invented from approximate display text.
function integer(text: string): number | null {
  const normalized = text.normalize("NFKC").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) ? number : null;
}

function readCounter(view: LocalView, label: string): { value: number; x: number; y: number } | null {
  const target = normalize(label);
  const candidates: Array<{ value: number; x: number; y: number }> = [];
  for (const element of view.elements) {
    if (element.confidence < 0.9) continue;
    const text = normalize(element.text);
    // Label and number may be in one OCR box, or two uniquely adjacent boxes.
    const inline = text.startsWith(`${target}:`) ? text.slice(target.length + 1).trim()
      : text.startsWith(`${target} `) ? text.slice(target.length + 1).trim() : null;
    if (inline !== null) {
      const value = integer(inline);
      if (value !== null) candidates.push({ value, ...element.center });
      continue;
    }
    if (text !== target) continue;
    const right = element.bounds.left + element.bounds.width;
    const values = view.elements.filter(other => other !== element && other.confidence >= 0.9
      && other.bounds.left >= right - 2 && other.bounds.left - right <= view.frame.width * 0.12
      && Math.abs(other.center.y - element.center.y) <= Math.max(element.bounds.height, other.bounds.height) * 0.45
      && integer(other.text) !== null);
    if (values.length === 1) candidates.push({ value: integer(values[0].text)!, ...element.center });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** Reads current OCR evidence; never presses a control or requests a model.
 * "new_text" proves only a new UI response, not a saved artifact. Counter
 * changes prove what is displayed, not persistence in the phone's filesystem. */
export function prepareResultReadback(spec: ResultReadback, before: LocalView) {
  const oldCounter = spec.kind === "counter_delta" ? readCounter(before, spec.label) : null;
  if (spec.kind === "counter_delta" && !oldCounter) throw new Error("Result read-back needs one exact visible baseline counter; no action sent");
  if (spec.kind === "new_text" && before.elements.some(e => normalize(e.text) === normalize(spec.label))) {
    throw new Error("Result response text already exists before the action; no action sent");
  }
  return (after: LocalView): ReadbackEvidence => {
    if (after.deviceId !== before.deviceId || after.frame.width !== before.frame.width || after.frame.height !== before.frame.height
      || after.frame.sequence <= before.frame.sequence || after.frame.capturedAt <= before.frame.capturedAt
      || after.timing.ocrCacheHit || after.timing.ocrCapturedAt !== after.frame.capturedAt) {
      throw new Error("Result read-back requires a fresh independent frame from the same device and geometry");
    }
    if (spec.kind === "new_text") {
      const matches = after.elements.filter(e => e.confidence >= 0.9 && normalize(e.text) === normalize(spec.label));
      return { kind: spec.kind, label: spec.label, level: "ui_response", met: matches.length === 1,
        before: null, after: matches.length === 1 ? matches[0].text : null,
        reason: matches.length === 1 ? "matched" : "missing_or_ambiguous", storageVerified: false };
    }
    const current = readCounter(after, spec.label);
    const layoutStable = current && Math.hypot(current.x - oldCounter!.x, current.y - oldCounter!.y) <= Math.max(4, before.frame.width * 0.01);
    const met = Boolean(current && layoutStable && current.value - oldCounter!.value === spec.delta);
    return { kind: spec.kind, label: spec.label, level: "displayed_value_change", met,
      before: oldCounter!.value, after: current?.value ?? null, storageVerified: false,
      reason: !current ? "missing_or_ambiguous" : !layoutStable ? "layout_changed" : met ? "matched"
        : current.value === oldCounter!.value ? "unchanged" : "unexpected_delta" };
  };
}
