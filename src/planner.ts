// The planner is the brain and the single extension point. It is re-entrant: the
// engine calls next() each round with the goal and the current context, and the
// planner returns the steps to run now (or done). Static workflows and dynamic
// agents are both just planners — the difference is how many steps they return
// per round (the ReAct↔ReWOO dial).
import { AgentError, JsonRpcCodes } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";
import type { Plan, Step, Binding } from "./types.ts";
import type { RunContext } from "./context.ts";
import type { AgentRegistry } from "./registry.ts";
import type { Decider, AgentChoice } from "./model.ts";
import { partsToText } from "./model.ts";
import { resolveBindings } from "./binding.ts";

export interface Planner {
  next(goal: import("@agentcompose/sdk").Part[], ctx: RunContext): Promise<Plan> | Plan;
}

export interface AuthoredPlanOptions {
  /** Build the final result from context; defaults to the last step's output. */
  result?: (ctx: RunContext) => import("@agentcompose/sdk").Part[];
}

/**
 * A deterministic-workflow planner: a fixed DAG of steps, authored up front. It
 * returns the whole DAG until every step has completed, then signals done. This
 * is the "workflow" pole — predictable and inspectable. The executor derives
 * dependencies from the steps' variable references and runs them in order.
 *
 * Note: authored plans are deterministic given the goal, so regenerating the plan
 * on resume yields the same steps; the executor skips already-completed ones. A
 * non-deterministic (e.g. LLM) planner must persist its plan instead — a seam-level
 * concern to address when that planner lands.
 */
export function authoredPlan(steps: Step[], opts: AuthoredPlanOptions = {}): Planner {
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new Error(`Duplicate step id "${s.id}" in authored plan.`);
    ids.add(s.id);
  }
  return {
    next(_goal, ctx) {
      const allDone = steps.every((s) => ctx.has(s.id));
      if (allDone) {
        const last = steps.at(-1);
        const result = opts.result ? opts.result(ctx) : last ? ctx.get(last.id) : [];
        return { steps: [], done: true, result };
      }
      return { steps };
    },
  };
}

export interface DynamicPlannerOptions {
  /** The model seam — an adapter that turns a DecisionRequest into an Action. */
  decider: Decider;
  /** Source of the agent catalog the decider chooses from. */
  registry: AgentRegistry;
  /** Safety cap on rounds (steps) before the run is failed. Default 16. */
  maxRounds?: number;
}

/**
 * A dynamic planner: each round it asks the `decider` what to do next, given the
 * goal, the observations so far, and the available agents. One step per round —
 * the ReAct pole. The planner itself is provider-neutral pure logic; all model
 * contact lives behind the `Decider` port.
 *
 * Re-derivable on resume: it is a pure function of (goal, completed outputs in ctx)
 * plus the decider. With a re-derivable decider (e.g. a real model prompted only
 * with restored observations), resuming re-asks from the same state — so the plan
 * need not be persisted; only step outputs are. The next step id is `step-N` where
 * N is the number of completed steps, which keeps ids stable across resume.
 */
export function dynamicPlanner(opts: DynamicPlannerOptions): Planner {
  const maxRounds = opts.maxRounds ?? 16;
  return {
    async next(goal, ctx) {
      const done = ctx.completed();
      if (done.length >= maxRounds) {
        throw new AgentError(
          JsonRpcCodes.InternalError,
          `Dynamic planner exceeded maxRounds=${maxRounds} without finishing.`,
        );
      }

      const choices: AgentChoice[] = [];
      for (const name of opts.registry.names()) {
        const d = await opts.registry.describe(name);
        const caps = d.capabilities?.map((c) => c.description).filter(Boolean).join("; ") ?? "";
        choices.push({ name, title: d.name, description: caps });
      }

      const action = await opts.decider.decide({
        goal: partsToText(goal),
        observations: done.map((id) => ({ stepId: id, text: partsToText(ctx.get(id)) })),
        choices,
      });

      if (action.kind === "finish") {
        const result = action.use?.length
          ? resolveBindings(toBindings(action.use, ctx), ctx)
          : [{ kind: "text", text: action.text ?? "" } satisfies Part];
        return { steps: [], done: true, result };
      }

      if (action.kind !== "call") {
        throw new AgentError(JsonRpcCodes.InvalidParams, `Decider returned unknown action kind.`);
      }
      if (!opts.registry.has(action.agent)) {
        throw new AgentError(
          JsonRpcCodes.InvalidParams,
          `Decider chose unregistered agent "${action.agent}". Available: ${opts.registry.names().join(", ")}.`,
        );
      }

      const input: Binding[] = [];
      if (action.instruction) input.push({ from: "const", parts: [{ kind: "text", text: action.instruction }] });
      input.push(...toBindings(action.use ?? [], ctx));
      if (input.length === 0) input.push({ from: "goal" });

      return { steps: [{ id: `step-${done.length}`, agent: action.agent, input }] };
    },
  };
}

/** Map decider `use` tokens ("goal" | a prior step id) to executor bindings. */
function toBindings(use: string[], ctx: RunContext): Binding[] {
  return use.map((u) => {
    // Tolerate model casing/variants for the goal token ("goal", "GOAL", "Goal").
    if (u.trim().toLowerCase() === "goal") return { from: "goal" } satisfies Binding;
    if (ctx.has(u)) return { from: "step", ref: u } satisfies Binding;
    throw new AgentError(JsonRpcCodes.InvalidParams, `Decider referenced unknown step "${u}".`);
  });
}
