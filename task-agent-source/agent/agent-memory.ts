import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type AgentMemoryRecord = {
  runId: string;
  deviceId: string;
  goal: string;
  intentType: string;
  actionType: string;
  beforeFingerprint: string;
  afterFingerprint: string | null;
  success: boolean;
  confidence: number;
  elapsedMs: number;
  recordedAt: string;
};

export interface AgentMemory {
  record(value: AgentMemoryRecord): Promise<void>;
}

export class FileAgentMemory implements AgentMemory {
  private writeQueue = Promise.resolve();

  constructor(
    readonly path = resolve(
      process.env.SCREENHAND_AGENT_MEMORY_PATH ?? "build/runtime/general-agent-memory.jsonl",
    ),
  ) {}

  record(value: AgentMemoryRecord) {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(value)}\n`, "utf8");
    });
    return this.writeQueue;
  }
}

export class InMemoryAgentMemory implements AgentMemory {
  readonly records: AgentMemoryRecord[] = [];

  async record(value: AgentMemoryRecord) {
    this.records.push(value);
  }
}
