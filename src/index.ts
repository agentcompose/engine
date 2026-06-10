// @agentcompose/engine — headless orchestration on top of @agentcompose/sdk.
//
// Layering:
//   Coordinator — the "hands": execute calls across agents (built).
//   Engine      — the "brain": turn a goal into a plan, then run it (next).
export { Coordinator } from "./coordinator.ts";
export type { Member, EventSink, CallOptions } from "./coordinator.ts";
