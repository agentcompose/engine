// @agentcompose/engine — headless orchestration on top of @agentcompose/sdk.
//
// Layering:
//   Coordinator — the "hands": execute calls across agents (composition primitive).
//   Engine      — the "brain + chassis": goal → plan → governed, durable execution.

// Engine (the runtime)
export { Engine } from "./engine.ts";
export type { EngineOptions, RunOptions, ResumeOptions, OnApproval } from "./engine.ts";

// Recursive composition: expose an Engine as an agent (an engine can be a step
// inside another engine).
export { asAgent } from "./as-agent.ts";
export type { AsAgentOptions } from "./as-agent.ts";

// Plan / step model
export type { Plan, Step, Binding, EngineEvent, Snapshot, RunStatus, Pending } from "./types.ts";

// Seams the product injects
export { AgentRegistry } from "./registry.ts";
export type { RegistryEntry } from "./registry.ts";
export { authoredPlan, dynamicPlanner } from "./planner.ts";
export type { Planner, AuthoredPlanOptions, DynamicPlannerOptions } from "./planner.ts";
// The planner's model seam (the "decide" port) + a no-network reference/test decider.
// Real model adapters are opt-in: `@agentcompose/engine/adapters/openai`.
export { ScriptedDecider, partsToText } from "./model.ts";
export type { Decider, Decision, Action, DecisionRequest, Observation, AgentChoice } from "./model.ts";
export { allowAll, approveWhen } from "./governor.ts";
export type { Governor, GovernorDecision } from "./governor.ts";
export { InMemoryCheckpointStore } from "./checkpoint.ts";
export type { CheckpointStore } from "./checkpoint.ts";
export { defaultRetryable, resolveRetry, computeBackoff, DEFAULT_RETRY } from "./retry.ts";
export type { RetryConfig, Retryable, ResolvedRetry } from "./retry.ts";
export { RunContext } from "./context.ts";

// Composition primitive (used inside agent handlers; the Engine drives clients directly)
export { Coordinator } from "./coordinator.ts";
export type { Member, EventSink, CallOptions } from "./coordinator.ts";
