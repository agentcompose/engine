// Working state for a single run: the goal, completed step outputs, and the set
// of steps a human has approved. Serializes to/from a Snapshot so a run can be
// checkpointed and resumed. This is the "working state" layer — distinct from
// durable state (CheckpointStore), cross-run memory (roadmap), and the
// event log (the EngineEvent stream).
import type { Part } from "@agentcompose/sdk";
import type { RunStatus, Snapshot, Pending } from "./types.ts";

export class RunContext {
  readonly runId: string;
  readonly goal: Part[];
  #outputs: Map<string, Part[]>;
  /** Steps approved by a human (seeded on resume); consulted by the governor path. */
  readonly approved: Set<string>;

  constructor(runId: string, goal: Part[], outputs?: Map<string, Part[]>, approved?: Set<string>) {
    this.runId = runId;
    this.goal = goal;
    this.#outputs = outputs ?? new Map();
    this.approved = approved ?? new Set();
  }

  has(stepId: string): boolean {
    return this.#outputs.has(stepId);
  }

  /** Output parts of a completed step, or throw if it has not run. */
  get(stepId: string): Part[] {
    const parts = this.#outputs.get(stepId);
    if (!parts) throw new Error(`No output for step "${stepId}" — referenced before it completed.`);
    return parts;
  }

  set(stepId: string, parts: Part[]): void {
    this.#outputs.set(stepId, parts);
  }

  /** Ids of all completed steps, in completion order. */
  completed(): string[] {
    return [...this.#outputs.keys()];
  }

  snapshot(status: RunStatus, extra?: { pending?: Pending; result?: Part[] }): Snapshot {
    return {
      runId: this.runId,
      goal: this.goal,
      status,
      outputs: Object.fromEntries(this.#outputs),
      ...(extra?.pending ? { pending: extra.pending } : {}),
      ...(extra?.result ? { result: extra.result } : {}),
    };
  }

  static from(snapshot: Snapshot, approved: Iterable<string> = []): RunContext {
    return new RunContext(
      snapshot.runId,
      snapshot.goal,
      new Map(Object.entries(snapshot.outputs)),
      new Set(approved),
    );
  }
}
