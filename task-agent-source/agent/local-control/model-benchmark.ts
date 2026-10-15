import { createHash } from "node:crypto";
import { z } from "zod";
import { plannerWireDecisionSchema, decodePlannerDecision, autonomousPlanningMessages, decisionRequest, planningDocument, type AutonomousDecision } from "./autonomous-planner";
import type { DecisionCase } from "./model-benchmark-cases";

export const CANDIDATES = [
  {id: "luna-none", model: "openai/gpt-5.6-luna", provider: "openai", excludeProviders: ["openai/flex", "openai/fast"], providerName: "OpenAI", effort: "none"},
  {id: "luna-azure-none", model: "openai/gpt-5.6-luna", provider: "azure", excludeProviders: ["azure/us", "azure/eu"], providerName: "Azure", effort: "none"},
  {id: "cerebras-120b-low", model: "openai/gpt-oss-120b", provider: "cerebras/fp16", providerName: "Cerebras", effort: "low"},
  {id: "groq-120b-low", model: "openai/gpt-oss-120b", provider: "groq", providerName: "Groq", effort: "low"},
  {id: "groq-20b-low", model: "openai/gpt-oss-20b", provider: "groq", providerName: "Groq", effort: "low"},
  {id: "gemini-lite-minimal", model: "google/gemini-3.5-flash-lite", provider: "google-vertex/global", excludeProviders: ["google-vertex/global/flex", "google-vertex/global/priority"], providerName: "Google", effort: "minimal"},
  {id: "gemini-current-low", model: "google/gemini-3.8-flash", provider: "google-vertex/global", excludeProviders: ["google-vertex/global/flex", "google-vertex/global/priority"], providerName: "Google", effort: "low"},
] as const;
export type Candidate = {id: string; model: string; provider: string; providerName: string; effort: string; excludeProviders?: readonly string[]};
export const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const unique = (texts: string[]) => new Set(texts.map(normalize)).size === texts.length;

export function gradeDecision(decision: AutonomousDecision, sample: DecisionCase) {
  const issues: string[] = [], document = planningDocument(sample.context).screen;
  const present = (text: string) => document.nodes.filter(n => normalize(n.text) === normalize(text)).length;
  if (sample.context.objectives.length && decision.objectives.length) issues.push("rewrites_frozen_objectives");
  // Match AutonomousPhoneRunner: an immediate blocked response may omit its
  // initial objectives; an action/complete response may not.
  if (!sample.context.objectives.length && !decision.objectives.length && decision.kind !== "blocked") issues.push("missing_initial_objectives");
  if (decision.kind === "action") {
    try {decisionRequest(decision);} catch {issues.push("runtime_contract_invalid");}
    const s = decision.step;
    if (s) {
      if (!unique(s.beforeTexts) || !s.beforeTexts.every(t => present(t) === 1)) issues.push("unguarded_current_page");
      if (!unique(s.afterTexts) || s.afterTexts.length < 2) issues.push("invalid_destination_evidence");
      // decisionRequest always expects overlay:none. Dismissing a dialog is a
      // real state change even when background destination labels are visible.
      if (document.overlay === "none" && s.afterTexts.every(t => present(t) > 0) && (s.afterKeyboard === null || s.afterKeyboard === document.keyboard)) issues.push("postcondition_already_true");
      if (["tap_text", "long_press_text"].includes(s.operation) && (!s.text || present(s.text) !== 1)) issues.push("target_not_unique_and_visible");
      if (document.overlay !== "none" && !(s.operation === "tap_text" && s.allowOverlay)) issues.push("action_behind_overlay");
      if (s.operation === "input_text" && (!sample.context.capabilities.inputText || !document.keyboard)) issues.push("input_unavailable");
      if (s.operation === "home" && !sample.context.capabilities.home) issues.push("home_unavailable");
      if (s.operation === "tap_visual" && !document.controls.some(c => c.shape === s.shape)) issues.push("invented_visual_control");
    }
  } else if (decision.step !== null) issues.push("non_action_has_step");
  if (decision.kind !== "complete" && decision.finalEvidence.length) issues.push("unexpected_final_evidence");
  for (const achieved of decision.achieved) {
    if (!unique(achieved.evidenceTexts) || !achieved.evidenceTexts.every(t => present(t) === 1)) issues.push("unsupported_achievement");
  }
  const expected = sample.expected.find(e => e.kind === decision.kind && (e.kind === "blocked" ||
    (decision.step?.operation === e.operation && (e.text === undefined || decision.step?.text === e.text) &&
      (e.allowOverlay === undefined || decision.step?.allowOverlay === e.allowOverlay))));
  if (!expected) issues.push("wrong_next_decision");
  if (expected?.kind === "action" && expected.destinationTexts && decision.step &&
    !decision.step.afterTexts.every(t => expected.destinationTexts!.some(v => normalize(v) === normalize(t)))) issues.push("predicted_destination_not_in_recording");
  // Correctness is this predeclared next-decision rubric; no simulated task completion.
  const destinationMatch = expected?.kind === "action" && expected.destinationTexts
    ? !issues.includes("predicted_destination_not_in_recording") : null;
  return {passed: issues.length === 0, nextDecisionCorrect: Boolean(expected), destinationMatch,
    executionContractValid: !issues.some(i => !["wrong_next_decision", "predicted_destination_not_in_recording"].includes(i)),
    issues: [...new Set(issues)]};
}

export function endpointFailure(body: string): "data_policy" | "parameters" | "no_endpoint" | "other" {
  if (/zero data retention|data policy/i.test(body)) return "data_policy";
  if (/unsupported|invalid parameter|parameter.*not supported/i.test(body)) return "parameters";
  if (/no endpoints|model.*not found/i.test(body)) return "no_endpoint";
  return "other";
}

export type BenchmarkSample = {candidate: string; caseId: string; source: DecisionCase["source"]; repeat: number; requestHash: string;
  status: "ok" | "http_error" | "provider_error" | "timeout" | "cancelled" | "transport_error" | "invalid_response" | "route_mismatch";
  elapsedMs: number; headersMs?: number; firstBodyByteMs?: number; validationMs?: number; httpStatus?: number;
  provider?: string; responseModel?: string; finishReason?: string; schemaValid: boolean;
  endpointFailure?: ReturnType<typeof endpointFailure>;
  providerErrorCode?: number;
  grade?: ReturnType<typeof gradeDecision>; decision?: AutonomousDecision;
  usage?: {promptTokens?: number; completionTokens?: number; reasoningTokens?: number; cachedTokens?: number; costUsd?: number};
};

export function requestBody(candidate: Candidate, sample: DecisionCase) {
  // The Azure route advertises max_completion_tokens, not max_tokens. With
  // require_parameters:true the wrong alias filters out an otherwise valid route.
  return {model: candidate.model, ...(candidate.provider === "azure" ? {max_completion_tokens: 1800} : {max_tokens: 1800}), stream: false,
    reasoning: {effort: candidate.effort, exclude: true},
    provider: {only: [candidate.provider], ignore: candidate.excludeProviders ?? [], allow_fallbacks: false, require_parameters: true,
      data_collection: "deny", zdr: true, max_price: {prompt: 2, completion: 10}},
    messages: autonomousPlanningMessages(sample.context),
    response_format: {type: "json_schema", json_schema: {name: "screenhand_next_step", strict: true, schema: z.toJSONSchema(plannerWireDecisionSchema)}},
  };
}

/** No hardware client, tool execution, image upload, retries, or fallback routes. */
export async function probe(candidate: Candidate, sample: DecisionCase, options: {
  apiKey: string; signal: AbortSignal; timeoutMs: number; repeat?: number; fetcher?: typeof fetch;
}): Promise<BenchmarkSample> {
  if (!options.apiKey.trim()) throw new Error("OPENROUTER_API_KEY is required");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) throw new Error("Invalid probe timeout");
  const body = requestBody(candidate, sample), started = performance.now();
  const timeout = AbortSignal.timeout(options.timeoutMs), signal = AbortSignal.any([options.signal, timeout]);
  const result: BenchmarkSample = {candidate: candidate.id, caseId: sample.id, source: sample.source, repeat: options.repeat ?? 0,
    requestHash: hash(body.messages), status: "transport_error", elapsedMs: 0, schemaValid: false};
  try {
    signal.throwIfAborted();
    const response = await (options.fetcher ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", redirect: "error", signal, headers: {Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json"}, body: JSON.stringify(body)});
    result.headersMs = performance.now() - started; result.httpStatus = response.status;
    if (!response.ok) {
      result.status = "http_error";
      const reader = response.body?.getReader();
      if (reader) {
        const parts: Uint8Array[] = []; let size = 0;
        try {while (size < 8192) {const part = await reader.read(); if (part.done) break; parts.push(part.value.subarray(0, 8192 - size)); size += part.value.length;}}
        finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
        // Only a closed classification leaves this boundary; never echo error text.
        result.endpointFailure = endpointFailure(Buffer.concat(parts).toString("utf8"));
      }
      return result;
    }
    const reader = response.body?.getReader();
    if (!reader) {result.status = "invalid_response"; return result;}
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
        result.firstBodyByteMs ??= performance.now() - started;
        size += next.value.length; if (size > 65_536) {result.status = "invalid_response"; return result;}
        chunks.push(next.value);
      }
    } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
    const validating = performance.now();
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // OpenRouter can send HTTP 200 with an in-body upstream error, after it
      // has already committed the HTTP headers. This is not a model decision.
      if (payload.error) {
        result.status = "provider_error";
        result.providerErrorCode = Number.isInteger(payload.error.code) ? payload.error.code : undefined;
        result.endpointFailure = endpointFailure(JSON.stringify(payload.error)); return result;
      }
      const short = (s: unknown) => typeof s === "string" && /^[a-zA-Z0-9 ./:_-]{1,180}$/.test(s) ? s : undefined;
      result.provider = short(payload.provider); result.responseModel = short(payload.model);
      result.finishReason = short(payload.choices?.[0]?.finish_reason);
      const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
      result.usage = {promptTokens: numeric(payload.usage?.prompt_tokens), completionTokens: numeric(payload.usage?.completion_tokens),
        reasoningTokens: numeric(payload.usage?.completion_tokens_details?.reasoning_tokens), cachedTokens: numeric(payload.usage?.prompt_tokens_details?.cached_tokens), costUsd: numeric(payload.usage?.cost)};
      if (!result.provider || !result.responseModel) {result.status = "invalid_response"; return result;}
      if (result.provider !== candidate.providerName ||
        !(result.responseModel === candidate.model || result.responseModel.startsWith(`${candidate.model}-20`))) {result.status = "route_mismatch"; return result;}
      if (result.finishReason !== "stop" || payload.choices?.[0]?.message?.refusal) {result.status = "invalid_response"; return result;}
      result.decision = decodePlannerDecision(JSON.parse(payload.choices[0].message.content));
      result.schemaValid = true; result.grade = gradeDecision(result.decision, sample); result.status = "ok";
    } catch {result.status = "invalid_response";}
    finally {result.validationMs = performance.now() - validating;}
  } catch {result.status = options.signal.aborted ? "cancelled" : timeout.aborted ? "timeout" : "transport_error";}
  finally {result.elapsedMs = performance.now() - started;}
  return result;
}

export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
export function summarize(samples: BenchmarkSample[]) {
  return [...new Set(samples.map(s => s.candidate))].map(candidate => {
    const rows = samples.filter(s => s.candidate === candidate), valid = rows.filter(s => s.schemaValid), passed = rows.filter(s => s.status === "ok" && s.grade?.passed);
    const distribution = (a: BenchmarkSample[]) => ({n: a.length, p50Ms: percentile(a.map(s => s.elapsedMs), .5), p95Ms: percentile(a.map(s => s.elapsedMs), .95)});
    return {candidate, attempted: rows.length, schemaValid: valid.length, passed: passed.length,
      nextDecisionCorrect: rows.filter(s => s.grade?.nextDecisionCorrect).length,
      executionContractValid: rows.filter(s => s.grade?.executionContractValid).length,
      recorded: {n: rows.filter(s => s.source === "recorded-ocr").length, passed: passed.filter(s => s.source === "recorded-ocr").length},
      allAttempts: distribution(rows), validDecisionLatency: distribution(valid), correctDecisionLatency: distribution(passed),
      failures: rows.filter(s => !s.grade?.passed).map(s => ({caseId: s.caseId, repeat: s.repeat, status: s.status, httpStatus: s.httpStatus,
        providerErrorCode: s.providerErrorCode, endpointFailure: s.endpointFailure, issues: s.grade?.issues})),
      reportedCostUsd: rows.reduce((sum, s) => sum + (s.usage?.costUsd ?? 0), 0),
      costReportedSamples: rows.filter(s => s.usage?.costUsd !== undefined).length};
  });
}
