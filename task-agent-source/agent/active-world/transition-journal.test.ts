import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readTransitionJournal,
  TransitionJournal,
} from "./transition-journal";

test("transition journal writes ordered replayable JSONL", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-journal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "run", "transitions.jsonl");
  const journal = new TransitionJournal(path);
  await journal.initialize();
  journal.record({
    type: "run_started",
    runId: "run-1",
    deviceId: "fixture",
    goal: "open settings",
    mode: "dry_run",
    startedAt: 1,
  });
  journal.record({
    type: "run_finished",
    runId: "run-1",
    status: "planned",
    completedAt: 2,
    belief: emptyBelief(),
  });
  const status = await journal.flush();
  assert.deepEqual(status, { records: 2, writeErrors: 0 });
  const replay = await readTransitionJournal(path);
  assert.deepEqual(replay.map((record) => record.sequence), [1, 2]);
  assert.deepEqual(replay.map((record) => record.event.type), [
    "run_started",
    "run_finished",
  ]);
});

test("journal write failures are observable but do not reject the hot path", async () => {
  const journal = new TransitionJournal("/not-written.jsonl", async () => {
    throw new Error("disk unavailable");
  });
  await journal.initialize();
  assert.doesNotThrow(() => journal.record({
    type: "run_started",
    runId: "run-1",
    deviceId: "fixture",
    goal: "noop",
    mode: "dry_run",
    startedAt: 1,
  }));
  assert.deepEqual(await journal.flush(), {
    records: 1,
    writeErrors: 1,
    error: "disk unavailable",
  });
});

test("journal reader rejects corrupt and discontinuous records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "screenhand-journal-bad-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const malformed = join(directory, "malformed.jsonl");
  await writeFile(malformed, "not-json\n", "utf8");
  await assert.rejects(() => readTransitionJournal(malformed), /not valid JSON/);

  const discontinuous = join(directory, "discontinuous.jsonl");
  await writeFile(discontinuous, `${JSON.stringify({
    schemaVersion: "screenhand.active-world.v1",
    sequence: 2,
    recordedAt: 1,
    event: { type: "run_started" },
  })}\n`, "utf8");
  await assert.rejects(() => readTransitionJournal(discontinuous), /discontinuous/);
});

function emptyBelief() {
  return {
    revision: 0,
    observationCount: 0,
    updatedAt: 0,
    viewport: null,
    screen: null,
    motion: null,
    keyboardVisible: false,
    uncertainty: 1,
    elements: [],
    lastAction: null,
  };
}
