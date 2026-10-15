import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import { requestSchema } from "./contract";
import type { StepReport } from "./executor";

export type ResponseHint = {
  intent: unknown;
  requiredTexts: string[];
  requiredAccent: string[];
  observedNewText: string;
  observations: number;
  level: "observed_ui_response_only";
};
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().trim();
const textsSchema = z.array(z.string().max(120)).max(200);
function nearText(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Retrospective evidence, not an executable skill, plan or success memory.
 * Only novel text after a completed, guarded action with surviving page anchors
 * can become a prediction hint. Every future action is independently verified. */
export function deriveResponseHints(report: unknown, deviceId: string, fingerprint: string, now = Date.now()): ResponseHint[] {
  const root = z.object({ modelCalls: z.number().int().nonnegative(), steps: z.array(z.unknown()).max(12) }).safeParse(report);
  if (!root.success) return [];
  const hints: ResponseHint[] = [];
  for (const entry of root.data.steps) {
    const s = entry as Partial<StepReport> | null;
    if (!s || s.deviceId !== deviceId || s.calibrationFingerprint !== fingerprint || s.receipt?.status !== "completed"
      || !s.startedAt || !Number.isFinite(Date.parse(s.startedAt)) || Date.parse(s.startedAt) > now || now - Date.parse(s.startedAt) > 86_400_000) continue;
    const request = requestSchema.safeParse(s.request), before = textsSchema.safeParse(s.before?.text);
    if (!request.success || !before.success || (request.data.require?.textAll?.length ?? 0) < 2
      || request.data.require?.overlay !== "none" || request.data.intent.type === "navigate") continue;
    if (!Array.isArray(s.verificationSamples) || s.verificationSamples.length > 200) continue;
    const old = new Set([...before.data, ...(request.data.expect.textAll ?? [])].map(normalize)), counts = new Map<string, { text: string; sequences: Set<number> }>();
    const seen = new Set<number>();
    let latestTime = s.before?.capturedAt ?? 0;
    for (const sample of s.verificationSamples) {
      const text = textsSchema.safeParse(sample?.text);
      if (!text.success || !sample.eligible || sample.ocrCacheHit || sample.ocrCapturedAt !== sample.capturedAt
        || !Number.isSafeInteger(sample.sequence) || seen.has(sample.sequence) || sample.capturedAt <= latestTime
        || sample.overlay !== "none" || !Array.isArray(sample.assessment?.checks)) continue;
      const pageChecks = sample.assessment.checks.filter(c => !c.condition.startsWith("stable visual change ") && !c.condition.startsWith("result read-back "));
      if (pageChecks.length < 2 || !pageChecks.every(c => c.met)) continue;
      seen.add(sample.sequence); latestTime = sample.capturedAt;
      for (const value of new Set(text.data)) {
        const key = normalize(value);
        // Reject OCR spelling jitter; approximate matches are never used to tap.
        if ([...old].some(previous => nearText(key, previous)) || value.length < 3 || value.length > 40 || !/[\p{L}]/u.test(value)) continue;
        const found = counts.get(key) ?? { text: value, sequences: new Set<number>() };
        found.sequences.add(sample.sequence); counts.set(key, found);
      }
    }
    for (const { text, sequences } of counts.values()) if (sequences.size >= 2) {
      hints.push({ intent: request.data.intent, requiredTexts: request.data.require!.textAll!, requiredAccent: request.data.require?.accentText ?? [],
        observedNewText: text, observations: sequences.size, level: "observed_ui_response_only" });
    }
  }
  return hints.slice(0, 8);
}

/** Reads only bounded local task reports, without images, coordinates, goals,
 * credentials or stored executable plans. Optional history never triggers API
 * calls. Corrupt/foreign/old reports cannot become hints. */
export async function readResponseHints(directory: string, deviceId: string, fingerprint: string): Promise<ResponseHint[]> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter(n => /task.*\.json$/.test(n)).slice(-512);
  const files = (await Promise.all(names.map(async name => {
    const path = join(directory, name), stat = await lstat(path).catch(() => null);
    return stat?.isFile() && stat.size <= 1_000_000 ? { path, time: stat.mtimeMs } : null;
  }))).filter((f): f is { path: string; time: number } => f !== null).sort((a, b) => b.time - a.time).slice(0, 12);
  const hints: ResponseHint[] = [], unique = new Set<string>();
  for (const file of files) {
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) continue;
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1_000_000) continue;
      const data = Buffer.alloc(1_000_001), { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead > 1_000_000) continue;
      for (const hint of deriveResponseHints(JSON.parse(data.subarray(0, bytesRead).toString("utf8")), deviceId, fingerprint)) {
        const key = JSON.stringify({ intent: hint.intent, requiredTexts: hint.requiredTexts, text: normalize(hint.observedNewText) });
        if (!unique.has(key)) { unique.add(key); hints.push(hint); }
      }
      if (hints.length >= 8) break;
    } catch { /* Partial checkpoints and malformed history are not evidence. */ }
    finally { await handle.close(); }
  }
  return hints.slice(0, 8);
}
