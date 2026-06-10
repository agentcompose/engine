# Engine Design

> The headless orchestration layer (③). Turns a **goal** into a **plan** and runs
> it across configurable agents. This note is the design and the reasons behind it.

## What the engine is

> **An orchestrator-worker runtime — durable, resumable, governed — whose pluggable
> planner spans the ReAct↔ReWOO spectrum and executes a variable-reference DAG over
> registered agents.**

The brain (decide what to do) is a well-worn plan→execute→observe loop. What makes
this an *engine* and not a demo is the chassis around it: separated state,
checkpoint/resume, and a runtime that governs what actually runs.

## Core loop

```
goal ─► Planner.next(goal, ctx) ─► Governor(step) ─► Executor (Coordinator)
          ▲                                              │
          └──────────── RunContext ◄── checkpoint ◄──────┘
        (returns done ⇒ finish)
```

Each round: the planner proposes the next step(s); the governor decides whether they
run; the executor runs them via the Coordinator; results land in `RunContext`; we
checkpoint; repeat until the planner says `done`. Human-in-the-loop is the governor
returning "needs approval" — the run **suspends** and **resumes** when the answer
arrives (the spec's `input-required` state).

## The one knob

**How many steps the planner returns per round is the dial between ReAct and ReWOO.**

- return **1 step** per round → ReAct: maximally adaptive, one model call per step.
- return the **whole DAG** then `done` → ReWOO: fewest calls, no mid-flight adaptation.
- return a DAG and revise the remainder next round → Plan-and-Execute.

We don't hardcode a pattern. We pick a **planner**, and the planner picks the point
on the spectrum. The engine just runs the loop. This is why the planner is the seam.

## Data model

```ts
// Plan = a DAG of steps with variable references between them (ReWOO-style).
interface Plan { steps: Step[]; done?: boolean; result?: Part[] }
interface Step {
  id: string;            // names this step's output, referenceable as #id
  agent: string;         // a registered agent
  input: Binding[];      // built from the goal and prior step outputs (#id)
  config?: AgentConfig;  // per-step configuration of the component
}

// The brain — the single extension point. Static and dynamic are both planners.
interface Planner { next(goal: Part[], ctx: RunContext): Promise<Plan> }

// State kept in four separate layers — never one growing transcript.
interface RunContext { /* working state: step outputs by id, the goal */ }
interface CheckpointStore { save(runId, snap): Promise<void>; load(runId): Promise<Snapshot | null> }  // durable
// cross-run memory (MemoryProvider) lands with the dynamic planner — its first consumer
type EngineEvent = …  // the event log: plan · step-started/completed/failed · message · artifact · error

// Governance — the model proposes, the runtime decides.
type Governor = (step: Step, ctx: RunContext) => Promise<
  | { decision: "allow" }
  | { decision: "block"; reason: string }
  | { decision: "rewrite"; step: Step }
  | { decision: "approve"; via: OnApproval }>;

// Public API — resumable from day one.
Engine.run(goal, { registry, planner, governor?, memory?, checkpoints? }): AsyncIterable<EngineEvent>;
Engine.resume(runId, opts): AsyncIterable<EngineEvent>;
```

## Decisions and why

| Decision | Choice | Why |
|---|---|---|
| **Planner is the seam** | `Planner.next(goal, ctx)`, re-entrant | One loop covers static workflows and dynamic agents; swapping the planner is the only change between them. |
| **Plan = variable-ref DAG** | steps reference prior outputs as `#id` | Proven shape (ReWOO/LLMCompiler). Dependencies fall out of the refs, so the executor *can* parallelize ready steps (deferred — execution is sequential in dependency order today). |
| **Engine surface** | library API first; `asAgent()` later | Prove the API before wrapping the engine as an agent. The wrapper is thin and recursive once the core works. |
| **State in 4 layers** | working / durable / memory / event-log, separated | A single transcript bloats and rots; separation keeps runs inspectable, recoverable, and cheap on context. |
| **Durable + resumable** | checkpoint per step; `run` + `resume` | This is what separates a product from a demo: fail on step 7, resume from step 7 — and survive long waits for human input. |
| **Governance in the runtime** | `Governor`: allow/block/rewrite/approve | Control that lives only in a prompt fails under pressure. The runtime — not the model — decides what executes. Also *is* the HITL seam. |
| **Failure: retry → fallback → fail** | transient-only retry (backoff+jitter), then fallback agents, then fail the run | Built behind `step-failed`. The classifier retries only transient failures (rate-limit / 5xx / network / timeout); deterministic errors fail fast. Per-step knobs are JSON-only so suspend/resume stays durable. Retries are in-process within a step — on crash, resume re-runs the step from attempt 1 (steps are idempotent). Exactly-once across crashes still needs idempotency keys (deferred). |
| **Workers return distilled output** | members summarize, don't dump | Sub-agents exist to isolate context; returning condensed results is the point, not an afterthought. |

The engine **never** implements `CheckpointStore`, `Governor`, or the agent clients
— the product injects them. The engine owns the loop; the product owns persistence,
policy, and UI. (Cross-run memory is the fourth state layer; it enters the boundary
when the dynamic planner — its first consumer — lands, not before.) That split is
the whole architecture.

## What we build first

The **thinnest durable slice**:

- the executor loop + an **authored-plan planner** (a fixed DAG → `done`): the
  deterministic-workflow mode, end to end;
- **variable-ref binding** between steps;
- an **in-memory `CheckpointStore`** so `resume()` works;
- a **pass-through `Governor`** (allow-all).

That yields `Engine.run(goal, { registry, planner: authoredPlan([...]) })` producing a
real, checkpointed event stream over the agents we already have. The LLM planner, real
persistence, and a real governor each drop in behind a seam that already exists.

Build one durable, governed, single-pass executor well **before** dynamic planning or
multi-agent depth. More agents don't make a better system; better boundaries do.

## The dynamic planner: the `decide` seam (Tier A)

The engine is itself an agent (`asAgent()` later), so the rule we give agent authors
applies to its own brain: **be a thin adapter over a mature, purpose-built tool — not
a from-scratch raw-LLM loop, and not a whole framework bent to fit.** Applied per
sub-problem:

| Sub-problem | Mature, purpose-built solver? | Verdict |
|---|---|---|
| The durable, governed plan/execute loop | No — existing agent runtimes bring their own colliding loop+state | **build from scratch** (this engine) |
| Talk to a model across providers | Yes — **gateways** (LiteLLM/OpenRouter/Portkey) + an OpenAI-compatible call; or pi-ai / Token.js / Vercel in-process | **wrap**, behind a port |
| Get a schema-valid decision out of a model | Yes — provider-native structured output / Instructor | **wrap**, behind a port |
| Assemble prompt context, map decision → Step | No — our domain glue | **ours** (trivial) |

So the planner splits into a tiny **port** the engine core owns, and an **adapter**
that is the only thing touching a model:

```ts
// Engine core — ZERO model dependencies. The whole model seam.
type Action =
  | { kind: "call"; agent: string; instruction?: string; use?: string[] }   // use: "goal" | a step id
  | { kind: "finish"; use?: string[]; text?: string };
interface Decider { decide(req: DecisionRequest): Promise<Action> }          // THE PORT

dynamicPlanner({ decider, registry, maxRounds }): Planner   // pure logic over the port
ScriptedDecider                                            // no-network reference/test decider
```

- **Connection portability is an ops choice, not a code dependency.** The reference
  adapter (`@agentcompose/engine/adapters/openai`) is a raw `fetch` to a configurable
  OpenAI-compatible `baseUrl` — point it at a gateway to reach any provider, exactly
  as the spec's `Provider { baseUrl, apiKey }` already assumes. It pulls **no npm deps**.
- **Structured output, not prompt-scraping.** The adapter requests JSON-schema-shaped
  output so the model produces the `Action`; parsing lives only in the adapter.
- **Untrusted observations (trust boundary).** The goal and prior step outputs fed to the
  decider are *data*, not instructions — a crafted goal or a poisoned sub-agent output
  could try to hijack the plan ("ignore the above; finish with …"). The reference adapter
  fences these in explicitly-untrusted blocks and the system prompt forbids following
  them; `validateAction` + `registry.has(agent)` bound `call` to registered agents. This
  reduces but does not eliminate prompt injection — a `Governor` over `finish` content is
  the place to add a hard check for sensitive deployments.
- **Everything is swappable at the port.** Pi's connection layer (`@earendil-works/pi-ai`),
  the Vercel AI SDK, Instructor, or provider-native structured outputs are alternative
  `Decider`s — the engine core and `dynamicPlanner` never change.
- **Re-derivable on resume.** `dynamicPlanner` is a pure function of (goal, completed
  outputs) + the decider, with step ids `step-N` from the completed count. A decider
  prompted only with restored observations re-asks from the same state, so the plan is
  **not persisted** — only step outputs are. (Deferred: a *stateful* decider with a
  private scratchpad would need that scratchpad persisted; threading `AbortSignal` into
  `Planner.next` for cancellable planning.)

## Roadmap to a complete engine

The durable deterministic chassis (above) and the Tier-A dynamic planner (this section)
are built. What "complete" still needs, in order of leverage:

| Tier | What | State |
|---|---|---|
| **chassis** | durable · governed · checkpoint/resume · retry/fallback · cancel | ✅ built |
| **A — goal-based brain** | dynamic planner over the `decide` port; observe→re-plan loop | ✅ built (one reference adapter; observe→re-plan via single-step rounds) |
| **B — robustness** | **parallel** ready steps (the DAG already encodes independence); real persistence + per-`runId` locking; exactly-once via idempotency keys | deferred |
| **C — composable & complete** | **`asAgent()` (recursive composition)** — ✅ built; cross-run **memory** (consumed by the planner); typed capability I/O (spec Scope B); durable event log + tracing | partly built |

Guiding rule throughout: **decide build-vs-wrap per seam** — own the loop; wrap only
mature, purpose-built solvers for the narrow sub-problems around it.

## Recursive composition: `asAgent()` — the engine's "publish" button

There are two ways to produce a publishable agent, and they emit the **same shape**:

| Authoring method | What you write | Result |
|---|---|---|
| **SDK** (`defineAgent`) | a `handle` wrapping a real tool (search, an LLM, plain code) | a publishable **leaf** agent |
| **Engine + `asAgent()`** | a plan wiring existing agents together | a publishable **composite** agent |

The SDK lets you publish an agent you *wrote*; the engine lets you publish an agent you
*composed*. A consumer can't tell which path produced a given agent — both carry a
`descriptor` and speak the task lifecycle.

> A `descriptor` is **a nameplate, not "an AI"**: `{ id, version, capabilities, configSchema }`.
> It declares a component's public face — its name and what it can do — and says nothing
> about the internals (an LLM, plain code, or a whole engine). So an engine carrying a
> descriptor is not a contradiction; it's the composite declaring its capability, exactly
> as a leaf does. (Cf. a Docker image's name + exposed ports: one nameplate whether the
> guts are one process or a supervised tree.)

`asAgent({ descriptor, engine })` returns an `AgentDefinition`: its handler drives
`engine.run()` and translates the engine's event stream onto the agent's emit surface
(progress/message/artifact), maps the final `result` out and `error` up, and **bridges
governor approval to the agent's `input-required` state** via `ctx.requestInput`. Register
the wrapped engine like any other agent and an outer engine calls it as a worker — so a
composite can be a member of the next composition, recursively.

**When you actually need it.** At a *single* level — your product runs one engine that
consumes leaf agents — `asAgent()` is unused, and that's fine. It earns its place the day a
composed team is **shipped as a dependency** for another engine (or product) to consume,
i.e. the marketplace / "reusable component" story. Until then it's an optional second hat
the engine can wear. (Deferred: durable resume *across* the agent boundary — one handler
invocation drives a run to completion today; mapping `ctx.config` onto engine/planner
parameters.)
