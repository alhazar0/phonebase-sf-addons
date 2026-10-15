import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CANDIDATES, endpointFailure, gradeDecision, hash, percentile, probe, requestBody, summarize } from "./model-benchmark";
import { contextFor, exampleView, type DecisionCase } from "./model-benchmark-cases";
import { autonomousPlanningMessages, type AutonomousDecision } from "./autonomous-planner";

const sample: DecisionCase = {id: "fixture", source: "synthetic-challenge", provenance: "unit test",
  context: contextFor("打开设置", exampleView(["Settings", "Camera"])),
  expected: [{kind: "action", operation: "tap_text", text: "Settings", destinationTexts: ["General", "Accessibility"]}]};
const decision: AutonomousDecision = {kind: "action", reason: "打开已看到的设置入口", objectives: ["打开设置"], achieved: [], finalEvidence: [],
  step: {operation: "tap_text", text: "Settings", direction: null, shape: null, beforeTexts: ["Settings"],
    afterTexts: ["General", "Accessibility"], afterKeyboard: null, completesObjective: 0, allowOverlay: false}};
const response = (value: unknown = decision, provider = "Cerebras", finish_reason = "stop") => new Response(JSON.stringify({provider, model: "openai/gpt-oss-120b",
  choices: [{finish_reason, message: {content: JSON.stringify(value)}}], usage: {prompt_tokens: 2500, completion_tokens: 200, cost: .001, completion_tokens_details: {reasoning_tokens: 50}}}));
const options = {apiKey: "test-private-key", signal: new AbortController().signal, timeoutMs: 1000};
const cerebras = CANDIDATES.find(c => c.id === "cerebras-120b-low")!;

test("benchmark reuses production prompt with no labels, images or hardware endpoint", () => {
  const images = structuredClone(sample); images.context.view.frame.image = "data:image/jpeg;base64,PRIVATE_IMAGE";
  const bodies = CANDIDATES.map(c => requestBody(c, images));
  for (const b of bodies) {
    assert.deepEqual(b.messages, autonomousPlanningMessages(images.context));
    assert(!JSON.stringify(b).includes("PRIVATE_IMAGE")); assert(!JSON.stringify(b.messages).includes("destinationTexts"));
    assert.equal(b.provider.allow_fallbacks, false); assert.equal(b.provider.zdr, true); assert.equal(b.provider.data_collection, "deny");
  }
  assert.equal(new Set(bodies.map(b => hash(b.messages))).size, 1);
});
test("grades correct, hallucinated, duplicated and already-satisfied targets separately", () => {
  assert(gradeDecision(decision, sample).passed);
  for (const patch of [{text: "Invented"}, {afterTexts: ["General", "Missing"]}, {afterTexts: ["Settings", "Camera"]}, {beforeTexts: ["Missing"]}]) {
    assert(!gradeDecision({...decision, step: {...decision.step!, ...patch}}, sample).passed);
  }
  const duplicate = structuredClone(sample); duplicate.context.view = exampleView(["Settings", "Settings"]);
  assert(gradeDecision(decision, duplicate).issues.includes("target_not_unique_and_visible"));
});
test("blocked is not counted correct on an actionable goal", () => {
  assert(!gradeDecision({...decision, kind: "blocked", step: null}, sample).passed);
});
test("input and overlay cannot bypass capability/evidence checks", () => {
  const dialog = structuredClone(sample); dialog.context.view.state.overlay = "dialog";
  assert(gradeDecision(decision, dialog).issues.includes("action_behind_overlay"));
  const input = {...decision, step: {...decision.step!, operation: "input_text" as const, text: "hello"}};
  assert(gradeDecision(input, sample).issues.includes("input_unavailable"));
});
test("captures full decision and route without invoking returned actions", async () => {
  let calls = 0;
  const result = await probe(cerebras, sample, {...options, fetcher: async (url, init) => {
    calls++; assert.equal(url, "https://openrouter.ai/api/v1/chat/completions"); assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(init!.body as string).provider.only, ["cerebras/fp16"]); return response();
  }});
  assert.equal(calls, 1); assert.equal(result.status, "ok"); assert(result.grade?.passed); assert.equal(result.usage?.reasoningTokens, 50);
});
test("does not expose provider error bodies or retry them", async () => {
  let calls = 0;
  const result = await probe(cerebras, sample, {...options, fetcher: async () => {calls++; return new Response("test-private-key echoed", {status: 400});}});
  assert.equal(calls, 1); assert.equal(result.status, "http_error"); assert.equal(result.httpStatus, 400);
  assert(!JSON.stringify(result).includes("test-private-key"));
});
test("rejects other providers, truncated JSON, malformed schemas and oversized bodies", async () => {
  for (const [r, expected] of [[response(decision, "Groq"), "route_mismatch"], [response(decision, "Cerebras", "length"), "invalid_response"],
    [response({}), "invalid_response"], [new Response("x".repeat(70_000)), "invalid_response"]] as const) {
    const result = await probe(cerebras, sample, {...options, fetcher: async () => r});
    assert.equal(result.status, expected); assert.equal(result.schemaValid, false);
  }
});
test("timeouts and cancellation remain failures, not missing fast samples", async () => {
  const result = await probe(cerebras, sample, {...options, timeoutMs: 100, fetcher: async (_url, init) => {
    await delay(1000, undefined, {signal: init!.signal!}); return response();
  }});
  assert.equal(result.status, "timeout"); assert(result.elapsedMs >= 90);
  const abort = new AbortController(); abort.abort(); let calls = 0;
  const cancelled = await probe(cerebras, sample, {...options, signal: abort.signal, fetcher: async () => {calls++; return response();}});
  assert.equal(calls, 0); assert.equal(cancelled.status, "cancelled");
  const summary = summarize([result, cancelled])[0]; assert.equal(summary.attempted, 2); assert.equal(summary.passed, 0);
  assert.equal(summary.validDecisionLatency.p50Ms, null);
});
test("latency quantiles use nearest rank and do not mutate samples", () => {
  const data = [900, 100, 400]; assert.equal(percentile(data, .5), 400); assert.equal(percentile(data, .95), 900);
  assert.deepEqual(data, [900, 100, 400]); assert.equal(percentile([], .5), null);
});
test("separates correct navigation from incorrect predicted destination labels", () => {
  const result = gradeDecision({...decision, step: {...decision.step!, afterTexts: ["Apple ID", "Bluetooth"]}}, sample);
  assert(result.nextDecisionCorrect); assert(result.executionContractValid); assert.equal(result.destinationMatch, false); assert(!result.passed);
});
test("endpoint errors are classified without including untrusted text", () => {
  assert.equal(endpointFailure("No endpoints found matching your data policy (Zero data retention)"), "data_policy");
  assert.equal(endpointFailure("unsupported parameter"), "parameters");
  assert.equal(endpointFailure("test-private-key"), "other");
});
test("Azure token parameter matches the pinned endpoint capabilities", () => {
  const body = requestBody(CANDIDATES.find(c => c.id === "luna-azure-none")!, sample);
  assert("max_completion_tokens" in body); assert.equal(body.max_completion_tokens, 1800); assert(!("max_tokens" in body));
});
test("HTTP 200 containing provider error is not a model or routing failure", async () => {
  const result = await probe(cerebras, sample, {...options, fetcher: async () => new Response(JSON.stringify({id: "r", error: {code: 502, message: "private body"}}))});
  assert.equal(result.status, "provider_error"); assert.equal(result.providerErrorCode, 502); assert(!result.schemaValid);
  assert(!JSON.stringify(result).includes("private body"));
});
test("dismissal can change overlay state even with currently visible destination text", () => {
  const dialog = structuredClone(sample); dialog.context.view = exampleView(["Settings", "Cancel", "General", "Accessibility"], "dialog");
  dialog.expected = [{kind: "action", operation: "tap_text", text: "Cancel", allowOverlay: true}];
  const d = {...decision, step: {...decision.step!, text: "Cancel", beforeTexts: ["Cancel"], allowOverlay: true}};
  assert(gradeDecision(d, dialog).passed);
});
test("matching provider cannot silently return a different model", async () => {
  const result = await probe(cerebras, sample, {...options, fetcher: async () => new Response(JSON.stringify({provider: "Cerebras", model: "different-model", choices: [{finish_reason: "stop", message: {content: JSON.stringify(decision)}}]}))});
  assert.equal(result.status, "route_mismatch");
});
test("initial blocked response may omit objectives exactly as the live runner permits", () => {
  const c = {...sample, expected: [{kind: "blocked" as const}]};
  assert(gradeDecision({...decision, kind: "blocked", objectives: [], step: null}, c).passed);
  assert(gradeDecision({...decision, objectives: []}, sample).issues.includes("missing_initial_objectives"));
});
