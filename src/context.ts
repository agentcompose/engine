// Working state for a single run: the goal, completed step outputs, and the set
// of steps a human has approved. Serializes to/from a Snapshot so a run can be
// checkpointed and resumed. This is the "working state" layer — distinct from
// durable state (CheckpointStore), cross-run memory (roadmap), and the
// event log (the EngineEvent stream).
import type { Part } from "@agentcompose/sdk";
import type { RunStatus, Snapshot, Pending } from "./types.ts";
import { inputKey } from "./types.ts";

export class RunContext {
  readonly runId: string;
  readonly goal: Part[];
  #outputs: Map<string, Part[]>;
  /** Answers to escalated inputs, keyed by inputKey(stepId, askIndex). Seeded on resume;
   *  consulted by the executor to feed a replaying worker its previously-given answers. */
  #inputs: Map<string, Part[]>;
  /** Steps approved by a human (seeded on resume); consulted by the governor path. */
  readonly approved: Set<string>;
  /** A pending suspension restored on resume (e.g. the exact approved step to run). */
  pending?: Pending;
  /** Trace identity for this run's observability spans. Assigned by the engine at run
   *  start and restored on resume so the whole run is one continuous trace. */
  traceId?: string;
  rootSpanId?: string;

  constructor(
    runId: string,
    goal: Part[],
    outputs?: Map<string, Part[]>,
    approved?: Set<string>,
    inputs?: Map<string, Part[]>,
  ) {
    this.runId = runId;
    this.goal = goal;
    this.#outputs = outputs ?? new Map();
    this.approved = approved ?? new Set();
    this.#inputs = inputs ?? new Map();
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

  /** A previously-recorded answer for an escalated input, or undefined. */
  getInput(stepId: string, askIndex: number): Part[] | undefined {
    return this.#inputs.get(inputKey(stepId, askIndex));
  }

  /** Record an answer for an escalated input (so a replay-resume can feed it back). */
  recordInput(stepId: string, askIndex: number, parts: Part[]): void {
    this.#inputs.set(inputKey(stepId, askIndex), parts);
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
      ...(this.#inputs.size ? { inputs: Object.fromEntries(this.#inputs) } : {}),
      ...(extra?.pending ? { pending: extra.pending } : {}),
      ...(extra?.result ? { result: extra.result } : {}),
      ...(this.traceId && this.rootSpanId ? { trace: { traceId: this.traceId, rootSpanId: this.rootSpanId } } : {}),
    };
  }

  static from(snapshot: Snapshot, approved: Iterable<string> = []): RunContext {
    const ctx = new RunContext(
      snapshot.runId,
      snapshot.goal,
      new Map(Object.entries(snapshot.outputs)),
      new Set(approved),
      new Map(Object.entries(snapshot.inputs ?? {})),
    );
    ctx.pending = snapshot.pending;
    ctx.traceId = snapshot.trace?.traceId;
    ctx.rootSpanId = snapshot.trace?.rootSpanId;
    return ctx;
  }
}
