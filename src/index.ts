// @agentcompose/engine — headless orchestration on top of @agentcompose/sdk.
//
// Layering:
//   Coordinator — the "hands": execute calls across agents (composition primitive).
//   Engine      — the "brain + chassis": goal → plan → governed, durable execution.

// Engine (the runtime)
export { Engine } from "./engine.ts";
export type { EngineOptions, RunOptions, ResumeOptions, OnApproval } from "./engine.ts";

// Plan / step model
export type { Plan, Step, Binding, EngineEvent, Snapshot, RunStatus, Pending } from "./types.ts";

// Seams the product injects
export { AgentRegistry } from "./registry.ts";
export type { RegistryEntry } from "./registry.ts";
export { authoredPlan } from "./planner.ts";
export type { Planner, AuthoredPlanOptions } from "./planner.ts";
export { allowAll, approveWhen } from "./governor.ts";
export type { Governor, GovernorDecision } from "./governor.ts";
export { InMemoryCheckpointStore } from "./checkpoint.ts";
export type { CheckpointStore } from "./checkpoint.ts";
export { RunContext } from "./context.ts";

// Composition primitive (used inside agent handlers; the Engine drives clients directly)
export { Coordinator } from "./coordinator.ts";
export type { Member, EventSink, CallOptions } from "./coordinator.ts";
