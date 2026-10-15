import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ScreenObservation } from "../general-agent-contract";
import { ActiveWorldSession } from "./session";
import { readTransitionJournal } from "./transition-journal";

test("session links a completed action to the first fresh camera observation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-session-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "transitions.jsonl");
  const indexed: string[] = [];
  const session = await ActiveWorldSession.open({
    runId: "run-1",
    deviceId: "fixture",
    goal: "open search",
    mode: "execute",
    journalPath: path,
    startedAt: 1,
    onTransition: (transition) => indexed.push(transition.transitionId),
  });
  session.observe(state(10, "home", "home-a", ["Telegram", "Search"]));
  const started = {
    executionId: "action-1",
    label: "open-search",
    action: {
      type: "tap" as const,
      point: { x: 360, y: 1_400 },
      viewport: { width: 720, height: 1_560 },
      frameSequence: 10,
      durationMs: 90,
    },
    startedAt: 2,
  };
  session.actionStarted(started);
  session.actionCompleted({
    ...started,
    completedAt: 3,
    result: {
      receipt: { id: "receipt-1", status: "completed", durationMs: 80 },
      elapsedMs: 95,
      response: {},
    },
  });
  session.observe(state(11, "spotlight", "search-a", ["Search", "Cancel"]));
  const summary = await session.finish("completed");
  assert.equal(summary.observations, 2);
  assert.equal(summary.actions, 1);
  assert.equal(summary.transitions, 1);
  assert.equal(summary.verifiedTransitions, 1);
  assert.equal(summary.unresolvedTransitions, 0);
  assert.equal(indexed.length, 1);

  const records = await readTransitionJournal(path);
  const transition = records.find((record) => record.event.type === "transition");
  assert.ok(transition?.event.type === "transition");
  assert.equal(transition.event.transition.precondition?.sequence, 10);
  assert.equal(transition.event.transition.postcondition?.sequence, 11);
  assert.equal(transition.event.transition.verification.freshFrame, true);
  assert.equal(transition.event.transition.verification.semanticChanged, true);
});

test("session redacts typed text and records failed actions without fake verification", async () => {
  const lines: string[] = [];
  const session = await ActiveWorldSession.open({
    runId: "run-2",
    deviceId: "fixture",
    goal: "type a message",
    mode: "execute",
    journalPath: join(tmpdir(), "screenhand-virtual-transitions.jsonl"),
    journalWriter: async (_path, line) => {
      lines.push(line);
    },
  });
  session.observe(state(20, "text_ui", "compose", ["Message"]));
  const started = {
    executionId: "action-2",
    label: "input-message",
    action: { type: "input_text" as const, text: "private content" },
    startedAt: 4,
  };
  session.actionStarted(started);
  session.actionFailed({
    ...started,
    completedAt: 5,
    error: new Error("keyboard unavailable"),
  });
  const summary = await session.finish("failed");
  assert.equal(summary.verifiedTransitions, 0);
  assert.equal(summary.unresolvedTransitions, 1);
  const records = lines.map((line) => JSON.parse(line));
  const action = records.find((record) => record.event.type === "action_started").event.action;
  assert.equal(action.action.text, "[REDACTED:15]");
  assert.equal(action.sensitiveTextRedacted, true);
  assert.doesNotMatch(lines.join(""), /private content/);
  const transition = records.find((record) => record.event.type === "transition").event.transition;
  assert.equal(transition.postcondition, null);
  assert.equal(transition.verification.freshFrame, false);
  assert.equal(transition.verification.reason, "action-failed");
});

function state(
  sequence: number,
  kind: string,
  fingerprint: string,
  labels: string[],
) {
  return {
    kind,
    confidence: 0.9,
    observation: observation(sequence, fingerprint, labels),
    tokens: labels.map((label) => label.toLowerCase()),
    detectedAt: 1_000 + sequence,
  };
}

function observation(sequence: number, fingerprint: string, labels: string[]): ScreenObservation {
  return {
    sequence,
    capturedAt: 900 + sequence,
    viewport: { width: 720, height: 1_560 },
    fingerprint,
    changeRatio: sequence === 10 || sequence === 20 ? null : 0.2,
    changeKind: sequence === 10 || sequence === 20 ? "first" : "major",
    ocrCacheHit: false,
    ocrElapsedMs: 20,
    observationElapsedMs: 25,
    averageTextConfidence: 0.9,
    textSignature: new Set(labels),
    elements: labels.map((text, index) => ({
      id: `ocr-${index}`,
      role: "text",
      text,
      confidence: 0.9,
      center: { x: 100, y: 100 + index * 50 },
      bounds: { left: 50, top: 90 + index * 50, width: 100, height: 20 },
    })),
    scene: {
      kind: "text_ui",
      confidence: 0.9,
      homeGridScore: 0,
      keyboardVisible: false,
    },
  };
}
