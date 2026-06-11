# Changelog

All notable changes to `@agentcompose/engine` are documented here. This project adheres
to [Semantic Versioning](https://semver.org/). Pre-1.0, minor versions may introduce
additive changes; breaking changes are avoided but possible while the contract settles.

## 0.1.1 — 2026-06-11

### Added
- **Nested HITL — escalate a required decision to the controller (Tier 1, replay mode).**
  A delegated agent that calls `requestInput` no longer fails the run; the request is an
  escalation to the engine, which acts as a *decider*. New `EscalationPolicy` seam
  (`escalate` / `resolve` / `deny`; default `escalateAll`, plus `resolveWith`). On
  `escalate` the run **suspends durably** (`Pending { kind: "input", address, prompt }`)
  and resumes via `resume(runId, { inputs })` or the `engine.provideInput(runId, parts,
  { stepId, askIndex? })` sugar — the asking step re-runs and the recorded answer is
  replayed into the worker. `Snapshot.inputs` persists answers; `InputAddress` /
  `inputKey` are exported. `asAgent()` bridges a nested worker's escalation to the
  wrapper's own `input-required`, so "escalate to my controller" works recursively in
  process — including **durable recursive route-down** across nested engines (a deep
  worker's escalation suspends the outer run and the answer routes back down on resume).
  Design: `docs/nested-hitl.md`. SemVer-additive.

## 0.1.0 — 2026-06-10

First published release. The headless orchestration engine: turn a goal into a plan and
execute it across configurable agents.

### Added
- `Engine` — durable, governed orchestrator-worker runtime: `run(goal)` / `resume(runId)`
  / `snapshot(runId)`, a re-entrant planner loop, variable-reference DAG execution in
  dependency order, per-step checkpointing, and cancellation.
- Planners: `authoredPlan` (fixed DAG) and `dynamicPlanner` (goal-driven, over a tiny
  model-agnostic `decide` port). `ScriptedDecider` for offline use.
- Governance: `Governor` seam (allow / block / rewrite / approve) with durable
  suspend/resume for human-in-the-loop approval; `approveWhen`, `allowAll`.
- Step resilience: transient-only retry with exponential backoff + jitter, per-step
  timeouts, and ordered fallback agents, with `step-retry` / `step-fallback` events.
- Recursive composition: `asAgent({ descriptor, engine })` publishes a composed team as
  an agent that consumers can't distinguish from a leaf.
- Per-use config overlay: a step's `config` layers over an agent's instance/base config.
- Reference model adapter `@agentcompose/engine/adapters/openai` (`openAICompatibleDecider`)
  — a dependency-free `fetch` to any OpenAI-compatible endpoint; handles streamed
  (text/event-stream) gateways.
- `InMemoryCheckpointStore`; `AgentRegistry`; in-memory state, no DB.
- Distribution: published as compiled JS + type declarations (`dist/`); Node ≥ 18.19.

### Known limitations
See [DESIGN.md](./DESIGN.md): sequential execution (parallel deferred), in-memory
persistence only, approval-resume does not re-govern, nested `input-required` across the
`asAgent` boundary fails fast, and exactly-once across crashes needs idempotency keys.
