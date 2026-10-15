import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ScreenHandSemanticAction } from "../action-contract";
import { SemanticWorldModel } from "./semantic-world-model";
import { TransitionJournal } from "./transition-journal";
import type {
  ActiveWorldBeliefSnapshot,
  ActiveWorldTransition,
} from "./types";

test("predicts a generic next screen and latency from verified visual transitions", () => {
  const model = new SemanticWorldModel([
    transition(1, true, "text_ui", 100),
    transition(2, true, "text_ui", 120),
    transition(3, true, "text_ui", 90),
    transition(4, false, null, null),
  ]);
  const prediction = model.predict({
    belief: belief(),
    action: tap(10),
    label: "open app",
  });
  assert.equal(prediction.sampleCount, 4);
  assert.equal(prediction.effectiveSamples, 4);
  assert.equal(prediction.successProbability, 0.75);
  assert.equal(prediction.predictedScreenKinds[0]?.kind, "text_ui");
  assert.equal(prediction.predictedScreenKinds[0]?.probability, 1);
  assert.ok((prediction.expectedLatencyMs ?? 0) >= 90);
  assert.ok((prediction.expectedLatencyMs ?? 0) <= 120);
  assert.ok(prediction.uncertainty < 0.6);
});

test("returns calibrated ignorance when no action evidence is similar", () => {
  const model = new SemanticWorldModel([transition(1, true, "text_ui", 100)]);
  const prediction = model.predict({
    belief: belief(),
    action: { type: "phone_key", key: "home" },
    label: "go home",
  });
  assert.equal(prediction.sampleCount, 0);
  assert.equal(prediction.successProbability, null);
  assert.equal(prediction.uncertainty, 1);
});

test("predicts a stable verified next-step target before full visual planning", () => {
  const model = new SemanticWorldModel([
    transition(1, true, "text_ui", 100),
    transition(2, true, "text_ui", 110),
    transition(3, true, "text_ui", 120),
  ]);
  const prediction = model.predictTarget({
    deviceId: "fixture",
    screenKind: "home_grid",
    tokens: ["telegram", "gemini"],
    label: "open app",
    viewport: { width: 720, height: 1_560 },
    sideEffect: "reversible",
    evaluatedAt: 500,
  });

  assert.equal(prediction.eligible, true);
  assert.equal(prediction.reason, "predicted-shadow-only");
  assert.equal(prediction.wouldMoveHardware, false);
  assert.equal(prediction.sampleCount, 3);
  assert.deepEqual(prediction.candidate?.point, { x: 120, y: 220 });
  assert.equal(prediction.targetErrorP95Pixels, 0);
});

test("holds target lookahead on sparse, unstable, unsafe, or unverified evidence", () => {
  const sparse = new SemanticWorldModel([transition(1, true, "text_ui", 100)]);
  assert.equal(sparse.predictTarget(targetQuery()).reason, "evidence-insufficient");
  assert.equal(sparse.predictTarget({
    ...targetQuery(),
    sideEffect: "external",
  }).reason, "side-effect-not-safe");

  const divergent = [
    transition(1, true, "text_ui", 100),
    transition(2, true, "text_ui", 100),
    transition(3, true, "text_ui", 100),
  ];
  setTapPoint(divergent[0], 80, 200);
  setTapPoint(divergent[1], 360, 780);
  setTapPoint(divergent[2], 650, 1_300);
  assert.equal(
    new SemanticWorldModel(divergent).predictTarget(targetQuery()).reason,
    "target-unstable",
  );

  const failures = new SemanticWorldModel([
    transition(1, false, null, null),
    transition(2, false, null, null),
    transition(3, false, null, null),
  ]);
  assert.equal(failures.predictTarget(targetQuery()).candidate, null);
});

test("loads valid transition journals and skips corrupt neighboring runs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-world-model-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new TransitionJournal(join(directory, "valid.jsonl"));
  await journal.initialize();
  journal.record({
    type: "transition",
    runId: "run-1",
    transition: transition(1, true, "text_ui", 100),
  });
  await journal.flush();
  await writeFile(join(directory, "corrupt.jsonl"), "not-json\n");
  const model = await SemanticWorldModel.fromJournalDirectory(directory);
  assert.equal(model.size(), 1);
});

test("restores verified target history recursively across service run directories", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-world-tree-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (let index = 1; index <= 3; index += 1) {
    const journal = new TransitionJournal(
      join(directory, `run-${index}`, "history.transitions.jsonl"),
    );
    await journal.initialize();
    journal.record({
      type: "transition",
      runId: `run-${index}`,
      transition: transition(index, true, "text_ui", 100),
    });
    await journal.flush();
  }
  await writeFile(join(directory, "corrupt.transitions.jsonl"), "not-json\n");
  const model = await SemanticWorldModel.fromJournalTree(directory);
  const prediction = model.predictTarget(targetQuery());

  assert.equal(model.size(), 3);
  assert.equal(prediction.eligible, true);
  assert.deepEqual(prediction.candidate?.point, { x: 120, y: 220 });
});

function transition(
  index: number,
  success: boolean,
  nextKind: string | null,
  latencyMs: number | null,
): ActiveWorldTransition {
  const startedAt = 1_000 + index * 1_000;
  return {
    transitionId: `transition-${index}`,
    runId: `run-${index}`,
    deviceId: "fixture",
    action: {
      executionId: `action-${index}`,
      label: "open app",
      action: tap(10),
      sensitiveTextRedacted: false,
      startedAt,
      beforeSequence: 10,
      ...(success
        ? {
            status: "completed" as const,
            completedAt: startedAt + 50,
            elapsedMs: 50,
            receiptId: `receipt-${index}`,
          }
        : {
            status: "failed" as const,
            completedAt: startedAt + 30,
            error: "fixture failure",
          }),
    },
    precondition: observation(10, "home_grid", startedAt - 20),
    postcondition: success && nextKind && latencyMs !== null
      ? observation(11, nextKind, startedAt + latencyMs)
      : null,
    verification: {
      freshFrame: success,
      visualChanged: success ? true : null,
      semanticChanged: success ? true : null,
      postSequenceDelta: success ? 1 : null,
      reason: success ? "fresh-post-action-observation" : "action-failed",
    },
  };
}

function observation(sequence: number, screenKind: string, observedAt: number) {
  return {
    sequence,
    capturedAt: observedAt - 10,
    observedAt,
    viewport: { width: 720, height: 1_560 },
    screenKind,
    sceneKind: screenKind,
    screenConfidence: 0.95,
    sceneConfidence: 0.95,
    fingerprint: `${screenKind}-${sequence}`,
    changeRatio: sequence === 10 ? null : 0.2,
    changeKind: sequence === 10 ? "first" as const : "major" as const,
    keyboardVisible: false,
    averageTextConfidence: 0.95,
    ocrElapsedMs: 10,
    observationElapsedMs: 15,
    tokens: sequence === 10 ? ["telegram", "gemini"] : ["chats", "search"],
    elements: [],
  };
}

function tap(sequence: number): ScreenHandSemanticAction {
  return {
    type: "tap",
    point: { x: 120, y: 220 },
    viewport: { width: 720, height: 1_560 },
    frameSequence: sequence,
    durationMs: 60,
  };
}

function targetQuery() {
  return {
    deviceId: "fixture",
    screenKind: "home_grid",
    tokens: ["telegram", "gemini"],
    label: "open app",
    viewport: { width: 720, height: 1_560 },
    sideEffect: "reversible" as const,
    evaluatedAt: 500,
  };
}

function setTapPoint(transitionValue: ActiveWorldTransition, x: number, y: number) {
  if (transitionValue.action.action.type === "tap") {
    transitionValue.action.action.point = { x, y };
  }
}

function belief(): ActiveWorldBeliefSnapshot {
  return {
    revision: 2,
    observationCount: 2,
    updatedAt: 1_000,
    viewport: { width: 720, height: 1_560 },
    screen: {
      kind: "home_grid",
      confidence: 0.95,
      candidateKind: null,
      candidateStreak: 0,
      stableFrames: 2,
      unknownStreak: 0,
      sequence: 10,
      capturedAt: 990,
      fingerprint: "home-10",
    },
    motion: { changeRatio: 0.001, changeKind: "stable" },
    keyboardVisible: false,
    uncertainty: 0.12,
    elements: [
      tracked("telegram", 1),
      tracked("gemini", 2),
    ],
    lastAction: null,
  };
}

function tracked(text: string, index: number) {
  return {
    id: `ui-${index}`,
    role: "text" as const,
    text,
    normalizedText: text,
    confidence: 0.95,
    center: { x: 0.2 * index, y: 0.2 },
    bounds: { left: 0.1, top: 0.1, width: 0.1, height: 0.05 },
    firstSeenSequence: 9,
    lastSeenSequence: 10,
    seenCount: 2,
  };
}
