// Runtime governance: the model/planner *proposes* a step; the runtime *decides*
// whether (and how) it runs. This is the enforcement seam that does not live in a
// prompt. The engine calls the Governor before executing every step.
//
//   allow   — run the step as proposed
//   rewrite — run a modified step instead (e.g. clamp config, redact input)
//   block   — refuse; the run fails with the given reason
//   approve — require human approval; the run suspends until approved on resume
import type { Step } from "./types.ts";
import type { RunContext } from "./context.ts";

export type GovernorDecision =
  | { decision: "allow" }
  | { decision: "rewrite"; step: Step }
  | { decision: "block"; reason: string }
  | { decision: "approve" };

export type Governor = (step: Step, ctx: RunContext) => Promise<GovernorDecision> | GovernorDecision;

/** Default governor: allow everything. The explicit, auditable "no policy" choice. */
export const allowAll: Governor = () => ({ decision: "allow" });

/** Require human approval for steps matching a predicate; allow the rest. */
export function approveWhen(needsApproval: (step: Step) => boolean): Governor {
  return (step) => (needsApproval(step) ? { decision: "approve" } : { decision: "allow" });
}
