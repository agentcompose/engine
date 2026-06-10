// The planner is the brain and the single extension point. It is re-entrant: the
// engine calls next() each round with the goal and the current context, and the
// planner returns the steps to run now (or done). Static workflows and dynamic
// agents are both just planners — the difference is how many steps they return
// per round (the ReAct↔ReWOO dial).
import type { Plan, Step } from "./types.ts";
import type { RunContext } from "./context.ts";

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
