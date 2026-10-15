import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ACTIVE_WORLD_SCHEMA_VERSION,
  type ActiveWorldJournalEvent,
  type ActiveWorldJournalRecord,
} from "./types";

export type TransitionJournalWriter = (path: string, line: string) => Promise<void>;

export class TransitionJournal {
  private pending: Promise<void> = Promise.resolve();
  private nextSequence = 1;
  private writeErrors = 0;
  private lastError: string | undefined;
  private initialized = false;

  private readonly writer: TransitionJournalWriter;

  constructor(readonly path: string, writer?: TransitionJournalWriter) {
    this.writer = writer ?? defaultWriter;
  }

  async initialize() {
    if (this.initialized) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.initialized = true;
  }

  record(event: ActiveWorldJournalEvent) {
    if (!this.initialized) {
      throw new Error("TransitionJournal must be initialized before recording events.");
    }
    const record: ActiveWorldJournalRecord = {
      schemaVersion: ACTIVE_WORLD_SCHEMA_VERSION,
      sequence: this.nextSequence++,
      recordedAt: Date.now(),
      event,
    };
    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending
      .then(() => this.writer(this.path, line))
      .catch((error) => {
        this.writeErrors += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    return record;
  }

  async flush() {
    await this.pending;
    return this.status();
  }

  status() {
    return {
      records: this.nextSequence - 1,
      writeErrors: this.writeErrors,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}

export async function readTransitionJournal(path: string) {
  const source = await readFile(path, "utf8");
  const records = source.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Transition journal line ${index + 1} is not valid JSON.`, {
        cause: error,
      });
    }
    return validateRecord(value, index + 1);
  });
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].sequence !== index + 1) {
      throw new Error(
        `Transition journal sequence is discontinuous at line ${index + 1}.`,
      );
    }
  }
  return records;
}

function validateRecord(value: unknown, line: number): ActiveWorldJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Transition journal line ${line} must be an object.`);
  }
  const record = value as Partial<ActiveWorldJournalRecord>;
  if (
    record.schemaVersion !== ACTIVE_WORLD_SCHEMA_VERSION ||
    !Number.isInteger(record.sequence) || Number(record.sequence) < 1 ||
    !Number.isFinite(record.recordedAt) ||
    !record.event || typeof record.event !== "object"
  ) {
    throw new Error(`Transition journal line ${line} has an invalid schema.`);
  }
  return record as ActiveWorldJournalRecord;
}

function defaultWriter(path: string, line: string) {
  return appendFile(path, line, { encoding: "utf8", mode: 0o600 });
}
