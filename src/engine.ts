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
import { AgentError, JsonRpcCodes, toRpcError } from "@agentcompose/sdk";
import type { Part, RpcError } from "@agentcompose/sdk";
import type { EngineEvent, Snapshot, Step, InputAddress } from "./types.ts";
import { inputKey } from "./types.ts";
import { RunContext } from "./context.ts";
import { AgentRegistry } from "./registry.ts";
import { resolveBindings, dependencies } from "./binding.ts";
import { allowAll } from "./governor.ts";
import type { Governor } from "./governor.ts";
import { escalateAll } from "./escalation.ts";
import type { EscalationPolicy } from "./escalation.ts";
import type { Planner } from "./planner.ts";
import { InMemoryCheckpointStore } from "./checkpoint.ts";
import type { CheckpointStore } from "./checkpoint.ts";
import { resolveRetry, computeBackoff, defaultRetryable } from "./retry.ts";
import type { RetryConfig, Retryable } from "./retry.ts";

/** Resolve a human approval inline (non-durable). For durable HITL, omit this and
 *  let the run suspend, then approve via resume(runId, { approvals }). */
export type OnApproval = (req: { step: Step }) => Promise<boolean> | boolean;

export interface EngineOptions {
  registry: AgentRegistry;
  planner: Planner;
  governor?: Governor;
  /** Decides what to do when a delegated agent escalates a required decision.
   *  Default: escalate everything (suspend → bubble to the controller). */
  escalation?: EscalationPolicy;
  checkpoints?: CheckpointStore;
  /** Engine-wide default retry knobs; per-step `Step.retry` overrides field-wise. */
  retry?: RetryConfig;
  /** Engine-wide classifier deciding which failures retry. Default: transient-only. */
  retryable?: Retryable;
}

export interface RunOptions {
  /** Provide a stable id (e.g. to control checkpoint keys); otherwise generated. */
  runId?: string;
  signal?: AbortSignal;
  onApproval?: OnApproval;
  /** Per-run override of the engine's escalation policy. */
  escalation?: EscalationPolicy;
}

export interface ResumeOptions {
  signal?: AbortSignal;
  /** Approvals for suspended steps, keyed by step id. */
  approvals?: Record<string, boolean>;
  /** Answers to escalated inputs, keyed by `inputKey(stepId, askIndex)`. */
  inputs?: Record<string, Part[]>;
  onApproval?: OnApproval;
  /** Per-run override of the engine's escalation policy. */
  escalation?: EscalationPolicy;
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

/** Thrown from #attempt when an escalation must suspend the run (not retried/failed).
 *  Carries the address + prompt + pinned step so resume re-runs exactly this step. */
class EscalationSuspend extends Error {
  readonly address: InputAddress;
  readonly prompt?: Part[];
  readonly proposed: Step;
  constructor(address: InputAddress, proposed: Step, prompt?: Part[]) {
    super(`Step "${address.stepId}" escalated input (ask #${address.askIndex}).`);
    this.address = address;
    this.prompt = prompt;
    this.proposed = proposed;
  }
}

/** Sleep that rejects with RunCanceled if the run's signal aborts during the wait. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new RunCanceled());
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new RunCanceled());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class Engine {
  #registry: AgentRegistry;
  #planner: Planner;
  #governor: Governor;
  #escalation: EscalationPolicy;
  #checkpoints: CheckpointStore;
  #retry: RetryConfig | undefined;
  #retryable: Retryable;

  constructor(opts: EngineOptions) {
    this.#registry = opts.registry;
    this.#planner = opts.planner;
    this.#governor = opts.governor ?? allowAll;
    this.#escalation = opts.escalation ?? escalateAll;
    this.#checkpoints = opts.checkpoints ?? new InMemoryCheckpointStore();
    this.#retry = opts.retry;
    this.#retryable = opts.retryable ?? defaultRetryable;
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
    // Merge newly-provided answers over any already in the checkpoint, then restore.
    const mergedInputs = { ...(snap.inputs ?? {}), ...(opts.inputs ?? {}) };
    const ctx = RunContext.from({ ...snap, inputs: mergedInputs }, approved);
    yield { type: "run-started", runId };
    yield* this.#drive(ctx, opts);
  }

  /** Sugar over resume(): answer one escalated input and continue the run.
   *  `askIndex` defaults to 0 (the common single-ask gate). */
  provideInput(
    runId: string,
    parts: Part[],
    target: { stepId: string; askIndex?: number },
    opts: Omit<ResumeOptions, "inputs"> = {},
  ): AsyncGenerator<EngineEvent> {
    const key = inputKey(target.stepId, target.askIndex ?? 0);
    return this.resume(runId, { ...opts, inputs: { [key]: parts } });
  }

  // ---- core loop ---------------------------------------------------------

  async *#drive(ctx: RunContext, opts: RunOptions & ResumeOptions): AsyncGenerator<EngineEvent> {
    const { signal, onApproval } = opts;
    const escalation = opts.escalation ?? this.#escalation;
    try {
      // Honor a pinned, human-approved suspension first: run exactly the step that was
      // reviewed, not one re-derived this round (a non-deterministic planner could drift
      // under the same id, executing un-reviewed work behind an approval). See DESIGN.md.
      const pin = ctx.pending;
      if (pin?.kind === "approval" && pin.proposed && ctx.approved.has(pin.stepId) && !ctx.has(pin.stepId)) {
        ctx.pending = undefined;
        yield { type: "plan", steps: [{ id: pin.proposed.id, agent: pin.proposed.agent }] };
        yield* this.#exec(pin.proposed, ctx, signal, escalation);
        await this.#checkpoints.save(ctx.runId, ctx.snapshot("running"));
      }

      // Honor a pinned escalated-input suspension: re-run the exact asking step. On the
      // re-run, #attempt finds the now-recorded answer and feeds it to the worker (replay
      // mode). If resume carried no answer for the awaited address, stay suspended.
      if (pin?.kind === "input" && !ctx.has(pin.address.stepId)) {
        if (ctx.getInput(pin.address.stepId, pin.address.askIndex) === undefined) {
          yield { type: "suspended", reason: pin };
          return;
        }
        ctx.pending = undefined;
        if (pin.proposed) {
          yield { type: "plan", steps: [{ id: pin.proposed.id, agent: pin.proposed.agent }] };
          yield* this.#exec(pin.proposed, ctx, signal, escalation);
          await this.#checkpoints.save(ctx.runId, ctx.snapshot("running"));
        }
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

          yield* this.#exec(toRun, ctx, signal, escalation);
          await this.#checkpoints.save(ctx.runId, ctx.snapshot("running"));
        }
      }
    } catch (err) {
      if (err instanceof RunCanceled) {
        await this.#checkpoints.save(ctx.runId, ctx.snapshot("canceled"));
        yield { type: "canceled" };
        return;
      }
      if (err instanceof EscalationSuspend) {
        const pending = { kind: "input" as const, address: err.address, prompt: err.prompt, proposed: err.proposed };
        await this.#checkpoints.save(ctx.runId, ctx.snapshot("suspended", { pending }));
        yield { type: "suspended", reason: pending };
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

  /** Execute one step with bounded retry + fallback, streaming its activity as events.
   *  Tries each candidate agent (primary, then fallbacks) up to its attempt budget;
   *  only transient failures retry, others move straight to the next candidate. */
  async *#exec(step: Step, ctx: RunContext, signal: AbortSignal | undefined, escalation: EscalationPolicy): AsyncGenerator<EngineEvent> {
    const policy = resolveRetry(this.#retry, step.retry, this.#retryable);
    const candidates = [step.agent, ...(step.fallback ?? [])];
    let lastError: RpcError | undefined;

    yield { type: "step-started", stepId: step.id, agent: step.agent };

    for (let c = 0; c < candidates.length; c++) {
      const agent = candidates[c];
      if (c > 0) yield { type: "step-fallback", stepId: step.id, from: candidates[c - 1], to: agent };

      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        if (signal?.aborted) throw new RunCanceled();
        try {
          const parts = yield* this.#attempt(step, agent, ctx, signal, policy.timeoutMs, escalation);
          ctx.set(step.id, parts);
          yield { type: "step-completed", stepId: step.id, parts };
          return;
        } catch (err) {
          if (err instanceof RunCanceled) throw err;
          if (err instanceof EscalationSuspend) throw err; // suspend, not a step failure
          const error = err instanceof StepFailed ? err.error : toRpcError(err);
          lastError = error;
          const isLast = attempt >= policy.maxAttempts;
          if (isLast || !policy.retryable(error, attempt)) break; // give up on this agent
          const delayMs = computeBackoff(policy, attempt);
          yield { type: "step-retry", stepId: step.id, agent, attempt, maxAttempts: policy.maxAttempts, delayMs, error };
          await abortableSleep(delayMs, signal); // throws RunCanceled on abort
        }
      }
    }

    // Every candidate exhausted — surface the last failure and fail the run (fail-fast).
    const error = lastError ?? { code: JsonRpcCodes.InternalError, message: `Step "${step.id}" failed.` };
    yield { type: "step-failed", stepId: step.id, error };
    throw new StepFailed(error);
  }

  /** One attempt against one agent. Streams progress; returns its result parts on
   *  success, or throws (StepFailed for a step-level failure, RunCanceled if the run
   *  was aborted). Does NOT emit step-started/step-failed — its caller (#exec) owns those. */
  async *#attempt(
    step: Step,
    agentName: string,
    ctx: RunContext,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    escalation: EscalationPolicy,
  ): AsyncGenerator<EngineEvent, Part[]> {
    const client = this.#registry.client(agentName);

    // Reset to the agent's base (instance) config each attempt, then layer this step's
    // per-use config over it. The reset gives step isolation when a shared client is
    // reused across steps; layering over the registry's base config (not bare schema
    // defaults) keeps instance config — e.g. an injected provider — alive on steps that
    // don't repeat it. A step's config is a per-use overlay on the configured instance;
    // concurrent reuse with differing configs would need per-use client instances.
    const base = this.#registry.configFor(agentName);
    await client.configure({ ...(base ?? {}), ...(step.config ?? {}) });

    const input = resolveBindings(step.input, ctx);
    const task = await client.submit(input);

    // A per-attempt timeout cancels the child and is surfaced as a (retryable) timeout.
    let timedOut = false;
    // Count requestInput calls within this step so multi-turn asks address distinctly,
    // and so a replay-resume feeds each turn its previously-recorded answer in order.
    let askIndex = 0;
    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            void client.cancel(task.id).catch(() => {});
          }, timeoutMs)
        : undefined;

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
          // A delegated agent escalated a required decision to us (its caller). The SDK
          // stream stays open in input-required, so we can answer and continue.
          const recorded = ctx.getInput(step.id, askIndex);
          if (recorded) {
            // Replaying after a durable suspend: feed the answer given on resume.
            await client.provideInput(task.id, recorded);
            askIndex++;
            continue;
          }
          const decision = await escalation({ stepId: step.id, askIndex, prompt: ev.prompt, ctx });
          if (decision.decision === "resolve") {
            ctx.recordInput(step.id, askIndex, decision.answer); // persist for replay consistency
            await client.provideInput(task.id, decision.answer);
            askIndex++;
            continue;
          }
          if (decision.decision === "deny") {
            await client.cancel(task.id).catch(() => {});
            throw new StepFailed({
              code: JsonRpcCodes.InvalidParams,
              message: `Step "${step.id}" input denied: ${decision.reason}`,
            });
          }
          // escalate: cancel the child and suspend the run durably; resume re-runs this
          // exact step and replays the recorded answer into it (replay mode).
          await client.cancel(task.id).catch(() => {});
          throw new EscalationSuspend({ stepId: step.id, askIndex }, step, ev.prompt);
        }
        // result/error are read authoritatively from the final task below.
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }

    const final = await client.get(task.id);
    if (final.state === "canceled") {
      // Distinguish a timeout-cancel (retryable step failure) from a run-abort (terminal).
      if (timedOut) throw new StepFailed({ code: JsonRpcCodes.InternalError, message: `Step "${step.id}" timed out after ${timeoutMs}ms.` });
      throw new RunCanceled();
    }
    if (final.state !== "completed") {
      throw new StepFailed(
        final.error ?? { code: JsonRpcCodes.InternalError, message: `Step "${step.id}" ended ${final.state} with no result.` },
      );
    }
    return final.result?.parts ?? [];
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
