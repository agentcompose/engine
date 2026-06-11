// Escalation: a delegated agent can need a decision it cannot make alone, so it
// escalates to its caller via the spec's input-required state. The engine is that
// caller — and a *decider*. For each escalation it either resolves it locally,
// escalates it onward (suspends the run → bubbles to its own controller, ultimately
// a human), or denies it. This is the relative, recursive "ask whoever controls me"
// primitive; "human" is just the root of the chain, reached through the product.
//
// Mechanism lives here (engine); the policy is the product's. The default escalates
// everything — the safe, auditable "I don't auto-answer" choice.
import type { Part } from "@agentcompose/sdk";
import type { RunContext } from "./context.ts";

export interface EscalationRequest {
  /** Step (a delegated agent) that raised the escalation. */
  stepId: string;
  /** 0-based index of this requestInput within the step (multi-turn support). */
  askIndex: number;
  /** The worker's structured ask, verbatim (what it passed to requestInput). */
  prompt?: Part[];
  /** Read-only working state, in case the decider can answer from prior outputs. */
  ctx: RunContext;
}

export type EscalationDecision =
  | { decision: "escalate" } // suspend the run → bubble to my controller (default)
  | { decision: "resolve"; answer: Part[] } // I answer it now, inline, no suspend
  | { decision: "deny"; reason: string }; // refuse → the step fails

export type EscalationPolicy = (
  req: EscalationRequest,
) => Promise<EscalationDecision> | EscalationDecision;

/** Default: escalate every request to the controller. Nothing is auto-answered. */
export const escalateAll: EscalationPolicy = () => ({ decision: "escalate" });

/** Resolve every request with a fixed answer (e.g. a test or a headless default). */
export function resolveWith(answer: Part[]): EscalationPolicy {
  return () => ({ decision: "resolve", answer });
}
