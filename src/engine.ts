// The Engine: a durable, governed orchestrator-worker runtime.
//
// Each round it asks the planner for the next step(s), runs each through the
// governance gate, executes the allowed ones via their registered agent client
// (streaming their activity), records outputs, and checkpoints — until the planner
// signals done. A run can suspend (for human approval) and resume from its last
// checkpoint, in the same process or a fresh one.
//
// Scope of this implementation (the durable deterministic slice) and deferrals are
// documented in DESIGN.md and noted inline where relevant.
import { AgentError, JsonRpcCodes, ErrorCodes, toRpcError } from "@agentcompose/sdk";
import type { Part, RpcError } from "@agentcompose/sdk";
import type { EngineEvent, Snapshot, Step } from "./types.ts";
import { RunContext } from "./context.ts";
import { AgentRegistry } from "./registry.ts";
import { resolveBindings, dependencies } from "./binding.ts";
import { allowAll } from "./governor.ts";
import type { Governor } from "./governor.ts";
import type { Planner } from "./planner.ts";
import { InMemoryCheckpointStore } from "./checkpoint.ts";
import type { CheckpointStore } from "./checkpoint.ts";

/** Resolve a human approval inline (non-durable). For durable HITL, omit this and
 *  let the run suspend, then approve via resume(runId, { approvals }). */
export type OnApproval = (req: { step: Step }) => Promise<boolean> | boolean;

export interface EngineOptions {
  registry: AgentRegistry;
  planner: Planner;
  governor?: Governor;
  checkpoints?: CheckpointStore;
}

export interface RunOptions {
  /** Provide a stable id (e.g. to control checkpoint keys); otherwise generated. */
  runId?: string;
  signal?: AbortSignal;
  onApproval?: OnApproval;
}

export interface ResumeOptions {
  signal?: AbortSignal;
  /** Approvals for suspended steps, keyed by step id. */
  approvals?: Record<string, boolean>;
  onApproval?: OnApproval;
}

/** Thrown internally when a step ends non-completed; surfaced as run failure. */
class StepFailed extends Error {
  readonly error: RpcError;
  constructor(error: RpcError) {
    super(error.message);
    this.error = error;
  }
}
class RunCanceled extends Error {}

export class Engine {
  #registry: AgentRegistry;
  #planner: Planner;
  #governor: Governor;
  #checkpoints: CheckpointStore;

  constructor(opts: EngineOptions) {
    this.#registry = opts.registry;
    this.#planner = opts.planner;
    this.#governor = opts.governor ?? allowAll;
    this.#checkpoints = opts.checkpoints ?? new InMemoryCheckpointStore();
  }

  /** Load the latest checkpoint for a run (e.g. to read its terminal result). */
  snapshot(runId: string): Promise<Snapshot | null> {
    return this.#checkpoints.load(runId);
  }

  /** Start a new run for a goal. Yields the orchestration event stream. */
  async *run(goal: Part[], opts: RunOptions = {}): AsyncGenerator<EngineEvent> {
    const runId = opts.runId ?? crypto.randomUUID();
    const ctx = new RunContext(runId, goal);
    // Checkpoint the initial state so a crash before step 1 is still resumable.
    await this.#checkpoints.save(runId, ctx.snapshot("running"));
    // Surface the (possibly generated) runId so the caller can resume()/snapshot() it.
    yield { type: "run-started", runId };
    yield* this.#drive(ctx, opts);
  }

  /** Resume a previously-checkpointed run from its last completed step. */
  async *resume(runId: string, opts: ResumeOptions = {}): AsyncGenerator<EngineEvent> {
    const snap = await this.#checkpoints.load(runId);
    if (!snap) {
      throw new AgentError(JsonRpcCodes.InvalidParams, `No run checkpointed as "${runId}".`);
    }
    if (snap.status === "completed") return void (yield { type: "result", parts: snap.result ?? [] });
    if (snap.status === "failed") {
      return void (yield { type: "error", error: snap.error ?? { code: JsonRpcCodes.InternalError, message: "failed" } });
    }
    if (snap.status === "canceled") return void (yield { type: "canceled" });

    // Durable denial: an explicit `false` for the suspended step rejects it and fails
    // the run (vs. "absent", which leaves it pending and re-suspends). The inline
    // onApproval path can already deny; this gives the checkpoint/resume path — the
    // real product path — the same "reject", not just "approve or keep waiting".
    if (snap.pending?.kind === "approval" && opts.approvals?.[snap.pending.stepId] === false) {
      const error: RpcError = {
        code: JsonRpcCodes.InvalidParams,
        message: `Step "${snap.pending.stepId}" denied by approver.`,
      };
      const ctx = RunContext.from(snap);
      await this.#checkpoints.save(runId, { ...ctx.snapshot("failed"), error });
      yield { type: "step-failed", stepId: snap.pending.stepId, error };
      yield { type: "error", error };
      return;
    }

    const approved = Object.entries(opts.approvals ?? {})
      .filter(([, ok]) => ok)
      .map(([id]) => id);
    const ctx = RunContext.from(snap, approved);
    yield { type: "run-started", runId };
    yield* this.#drive(ctx, opts);
  }

  // ---- core loop ---------------------------------------------------------

  async *#drive(ctx: RunContext, opts: RunOptions & ResumeOptions): AsyncGenerator<EngineEvent> {
    const { signal, onApproval } = opts;
    try {
      // Honor a pinned, human-approved suspension first: run exactly the step that was
      // reviewed, not one re-derived this round (a non-deterministic planner could drift
      // under the same id, executing un-reviewed work behind an approval). See DESIGN.md.
      const pin = ctx.pending;
      if (pin?.kind === "approval" && pin.proposed && ctx.approved.has(pin.stepId) && !ctx.has(pin.stepId)) {
        ctx.pending = undefined;
        yield { type: "plan", steps: [{ id: pin.proposed.id, agent: pin.proposed.agent }] };
        yield* this.#exec(pin.proposed, ctx, signal);
        await this.#checkpoints.save(ctx.runId, ctx.snapshot("running"));
      }

      // Re-entrant planner loop. authoredPlan returns the full DAG once, then done;
      // a dynamic planner can return one step per round (ReAct) — same loop.
      for (;;) {
        if (signal?.aborted) throw new RunCanceled();

        const plan = await this.#planner.next(ctx.goal, ctx);
        if (plan.done) {
          const result = plan.result ?? [];
          await this.#checkpoints.save(ctx.runId, ctx.snapshot("completed", { result }));
          yield { type: "result", parts: result };
          return;
        }
        if (plan.steps.length === 0) {
          throw new AgentError(JsonRpcCodes.InternalError, "Planner returned no steps and did not signal done.");
        }

        yield { type: "plan", steps: plan.steps.map((s) => ({ id: s.id, agent: s.agent })) };

        // Sequential execution in dependency order. Deferred (DESIGN.md): independent
        // steps could run in parallel — the variable-ref DAG already encodes the graph.
        for (const step of this.#order(plan.steps, ctx)) {
          if (ctx.has(step.id)) continue;
          if (signal?.aborted) throw new RunCanceled();

          const toRun = yield* this.#govern(step, ctx, onApproval);
          if (toRun === "suspend") return; // suspended event already yielded
          if (toRun === "blocked") return; // failure events already yielded

          yield* this.#exec(toRun, ctx, signal);
          await this.#checkpoints.save(ctx.runId, ctx.snapshot("running"));
        }
      }
    } catch (err) {
      if (err instanceof RunCanceled) {
        await this.#checkpoints.save(ctx.runId, ctx.snapshot("canceled"));
        yield { type: "canceled" };
        return;
      }
      const error = err instanceof StepFailed ? err.error : toRpcError(err);
      await this.#checkpoints.save(ctx.runId, { ...ctx.snapshot("failed"), error });
      yield { type: "error", error };
    }
  }

  /** Apply governance to a proposed step. Returns the step to run, or a sentinel. */
  async *#govern(
    step: Step,
    ctx: RunContext,
    onApproval: OnApproval | undefined,
  ): AsyncGenerator<EngineEvent, Step | "suspend" | "blocked"> {
    const verdict = await this.#governor(step, ctx);

    if (verdict.decision === "allow") return step;
    if (verdict.decision === "rewrite") {
      // A rewrite runs after ordering, so it must not change identity or it would
      // escape the computed dependency order. New step-refs must already be satisfied
      // (resolveBindings throws otherwise) — documented constraint.
      if (verdict.step.id !== step.id) {
        throw new AgentError(
          JsonRpcCodes.InvalidParams,
          `Governor rewrite must preserve step id ("${step.id}" → "${verdict.step.id}").`,
        );
      }
      return verdict.step;
    }
    if (verdict.decision === "block") {
      const error: RpcError = { code: JsonRpcCodes.InvalidParams, message: `Step "${step.id}" blocked by policy: ${verdict.reason}` };
      yield { type: "step-failed", stepId: step.id, error };
      await this.#checkpoints.save(ctx.runId, { ...ctx.snapshot("failed"), error });
      yield { type: "error", error };
      return "blocked";
    }
    // approve
    if (ctx.approved.has(step.id)) return step;
    if (onApproval) {
      const ok = await onApproval({ step });
      if (ok) {
        ctx.approved.add(step.id);
        return step;
      }
      const error: RpcError = { code: JsonRpcCodes.InvalidParams, message: `Step "${step.id}" denied by approver.` };
      yield { type: "step-failed", stepId: step.id, error };
      await this.#checkpoints.save(ctx.runId, { ...ctx.snapshot("failed"), error });
      yield { type: "error", error };
      return "blocked";
    }
    // Durable HITL: suspend to the checkpoint store and wait for resume + approval.
    // Pin the exact proposed step so resume runs what was reviewed (not a re-derivation).
    await this.#checkpoints.save(
      ctx.runId,
      ctx.snapshot("suspended", { pending: { kind: "approval", stepId: step.id, proposed: step } }),
    );
    yield { type: "suspended", reason: { kind: "approval", stepId: step.id } };
    return "suspend";
  }

  /** Execute one step against its agent, streaming its activity as engine events. */
  async *#exec(step: Step, ctx: RunContext, signal: AbortSignal | undefined): AsyncGenerator<EngineEvent> {
    const client = this.#registry.client(step.agent);
    yield { type: "step-started", stepId: step.id, agent: step.agent };

    // Reset to declared defaults each step, then layer this step's config. Without the
    // reset, a prior step's config would leak onto a later step that shares the agent
    // (the registry holds one shared client). Sequential execution makes this safe;
    // concurrent reuse with differing configs would need per-use client instances.
    await client.configure(step.config ?? {});

    const input = resolveBindings(step.input, ctx);
    const task = await client.submit(input);

    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => void client.cancel(task.id).catch(() => {});
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      for await (const ev of client.events(task.id)) {
        if (ev.type === "progress") yield { type: "progress", stepId: step.id, percent: ev.percent, message: ev.message };
        else if (ev.type === "message") yield { type: "message", stepId: step.id, delta: ev.delta };
        else if (ev.type === "artifact") yield { type: "artifact", stepId: step.id, artifact: ev.artifact };
        else if (ev.type === "status" && ev.state === "input-required") {
          // A sub-agent asking for input would otherwise hang this loop forever (the SDK
          // event stream only closes on a terminal state). Fail fast and cancel the child.
          // Deferred: bridging child input upward (durable, cross-process) — see DESIGN.md.
          await client.cancel(task.id).catch(() => {});
          const error: RpcError = {
            code: ErrorCodes.CapabilityNotSupported,
            message: `Step "${step.id}" agent "${step.agent}" requested input; nested input-required is not yet supported.`,
          };
          yield { type: "step-failed", stepId: step.id, error };
          throw new StepFailed(error);
        }
        // result/error are read authoritatively from the final task below.
      }
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }

    const final = await client.get(task.id);
    if (final.state === "canceled") throw new RunCanceled();
    if (final.state !== "completed") {
      const error: RpcError = final.error ?? {
        code: JsonRpcCodes.InternalError,
        message: `Step "${step.id}" ended ${final.state} with no result.`,
      };
      yield { type: "step-failed", stepId: step.id, error };
      throw new StepFailed(error);
    }

    const parts = final.result?.parts ?? [];
    ctx.set(step.id, parts);
    yield { type: "step-completed", stepId: step.id, parts };
  }

  /** Dependency order over a plan's not-yet-completed steps (Kahn; detects cycles). */
  #order(steps: Step[], ctx: RunContext): Step[] {
    const byId = new Map(steps.map((s) => [s.id, s]));
    const pending = steps.filter((s) => !ctx.has(s.id));
    const index = new Map(pending.map((s, i) => [s.id, i]));
    const indeg = new Map(pending.map((s) => [s.id, 0]));
    const adj = new Map<string, string[]>(pending.map((s) => [s.id, []]));

    for (const s of pending) {
      for (const dep of dependencies(s.input)) {
        if (ctx.has(dep)) continue; // already satisfied
        if (!byId.has(dep)) {
          throw new AgentError(JsonRpcCodes.InvalidParams, `Step "${s.id}" references unknown step "${dep}".`);
        }
        if (indeg.has(dep)) {
          adj.get(dep)!.push(s.id);
          indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
        }
      }
    }

    const ready = pending.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
    const out: Step[] = [];
    while (ready.length) {
      ready.sort((a, b) => (index.get(a)! - index.get(b)!)); // stable: authored order
      const id = ready.shift()!;
      out.push(byId.get(id)!);
      for (const n of adj.get(id)!) {
        indeg.set(n, indeg.get(n)! - 1);
        if (indeg.get(n) === 0) ready.push(n);
      }
    }
    if (out.length !== pending.length) {
      throw new AgentError(JsonRpcCodes.InvalidParams, "Plan has a dependency cycle.");
    }
    return out;
  }
}
