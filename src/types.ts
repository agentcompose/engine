// Engine types. The plan/step model is a variable-reference DAG: a step names its
// output, and later steps reference prior outputs as bindings. Dependencies are
// derived from those references — there is no separate edge list to keep in sync.
import type { Artifact, Part, AgentConfig, RpcError, SpanStart, SpanStatus, SpanEvent, AttrMap } from "@agentcompose/sdk";
import type { RetryConfig } from "./retry.ts";

/** How a step's input is assembled from the goal and prior step outputs. */
export type Binding =
  | { from: "goal" } // the run's goal parts
  | { from: "step"; ref: string } // another step's output, by its id
  | { from: "const"; parts: Part[] }; // literal parts

/** One unit of work: run a registered agent with an assembled input. */
export interface Step {
  /** Unique within a plan; names this step's output for later references. */
  id: string;
  /** Name of a registered agent (see AgentRegistry). */
  agent: string;
  /** Input assembly. Resolved left-to-right and concatenated. */
  input: Binding[];
  /** Per-step configuration of the agent component (validated by the agent). */
  config?: AgentConfig;
  /** Per-step retry knobs, overriding the engine default. JSON-only (serializable). */
  retry?: RetryConfig;
  /** Agents to try, in order, if the primary agent exhausts its attempts or fails
   *  non-retryably. Each fallback gets its own retry budget. */
  fallback?: string[];
}

/**
 * What the planner decides each round. `steps` is a DAG to run now; `done`
 * signals completion with an optional final `result`. Returning the whole DAG
 * once behaves like ReWOO; returning one step per round behaves like ReAct.
 */
export interface Plan {
  steps: Step[];
  done?: boolean;
  result?: Part[];
}

/** Lifecycle of a run. Mirrors the spec's task states where they overlap. */
export type RunStatus = "running" | "suspended" | "completed" | "failed" | "canceled";

/** Identifies exactly which escalation is waiting — the route-down target.
 *  `askIndex` is the 0-based count of `requestInput` calls within a step, so a
 *  worker that asks more than once (multi-turn) addresses each turn distinctly. */
export interface InputAddress {
  stepId: string;
  askIndex: number;
  // path?: string[];  // Tier 3: recursive stepId stack across asAgent() boundaries
  // taskId?: string;  // Tier 2: the live parked child (hold-open mode)
}

/** Stable key for an answer in `Snapshot.inputs` / `RunContext` inputs. */
export function inputKey(stepId: string, askIndex: number): string {
  return `${stepId}#${askIndex}`;
}

/** Why a suspended run is waiting.
 *  - `approval`: a human must approve a step *before* it runs.
 *  - `input`: a delegated agent escalated a required decision to the engine, and the
 *    engine escalated it onward (to its controller / the human) rather than resolving it.
 *  `proposed` pins the exact reviewed/asking step so resume executes *that*, not a freshly
 *  re-derived one (a non-deterministic planner could otherwise drift under the same id). */
export type Pending =
  | { kind: "approval"; stepId: string; proposed?: Step }
  | { kind: "input"; address: InputAddress; prompt?: Part[]; proposed?: Step };

/**
 * The complete, serializable state needed to resume a run in a fresh process.
 * Deliberately JSON-only: a database- or file-backed CheckpointStore is a drop-in.
 */
export interface Snapshot {
  runId: string;
  goal: Part[];
  status: RunStatus;
  /** Completed step outputs, keyed by step id. The source of truth for resume. */
  outputs: Record<string, Part[]>;
  /** Answers gathered for escalated inputs, keyed by `inputKey(stepId, askIndex)`.
   *  Makes a replay-resume deterministic: the re-run feeds these back to the worker. */
  inputs?: Record<string, Part[]>;
  pending?: Pending;
  result?: Part[];
  error?: RpcError;
  /** Trace identity, persisted so a resumed run continues the same trace (same ids)
   *  rather than starting a disconnected one. */
  trace?: { traceId: string; rootSpanId: string };
}

/** Events streamed from a run. The orchestration-level event log. */
export type EngineEvent =
  | { type: "run-started"; runId: string }
  | { type: "plan"; steps: { id: string; agent: string }[] }
  | { type: "step-started"; stepId: string; agent: string; instruction?: string; inputFrom?: string[] }
  | { type: "progress"; stepId: string; percent?: number; message?: string }
  | { type: "message"; stepId: string; delta: Part }
  | { type: "artifact"; stepId: string; artifact: Artifact }
  | { type: "step-completed"; stepId: string; parts: Part[] }
  | { type: "step-retry"; stepId: string; agent: string; attempt: number; maxAttempts: number; delayMs: number; error: RpcError }
  | { type: "step-fallback"; stepId: string; from: string; to: string }
  | { type: "step-failed"; stepId: string; error: RpcError }
  | { type: "suspended"; reason: Pending }
  | { type: "canceled" }
  | { type: "result"; parts: Part[] }
  | { type: "error"; error: RpcError }
  // Observability plane (mirrors the SDK's span events, minus taskId since a run is the
  // context). The engine emits a run-root span and one span per step, and re-stamps the
  // spans streamed up by delegated agents so the whole composition is one nested trace.
  | { type: "span-start"; span: SpanStart }
  | {
      type: "span-end";
      traceId: string;
      spanId: string;
      endTime: number;
      status: SpanStatus;
      attributes?: AttrMap;
      events?: SpanEvent[];
      error?: RpcError;
    };
