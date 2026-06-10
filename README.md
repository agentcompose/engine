# @agentcompose/engine

> Headless orchestration for [AgentCompose](https://github.com/agentcompose/spec) —
> turn a **goal** into a **plan** and execute it across configurable agents.
> Built on [`@agentcompose/sdk`](https://github.com/agentcompose/sdk-typescript).

**Status:** `0.0.x` early · **License:** Apache-2.0 · **Requires:** Node ≥ 22

This is layer **③** of the AgentCompose stack — the engine that products (UI, agent
builders, goal-based assistants) build on. It is **headless**: no UI, no database,
no presentation. It exposes interfaces a product injects.

```
④ PRODUCT   UI · memory store · human-in-the-loop UX        (separate, on top)
③ ENGINE    goal → plan → execute  ·  this repo
②  SDK      define / run / compose one agent                @agentcompose/sdk
①  SPEC     the AgentCompose contract                       agentcompose/spec
```

## Two parts: the hands and the brain

| Part | Role | Status |
|------|------|--------|
| **`Coordinator`** | the **hands** — execute calls across agents, wire output→input, forward progress, propagate cancel/errors | ✅ built |
| **`Engine`** | the **brain + chassis** — accept a *goal*, run a *plan* (deterministic now; dynamic later) through governance, durably and resumably | ✅ durable deterministic slice |

The difference is **goal-based vs imperative**: you hand the Coordinator explicit
calls; you hand the Engine a *goal* and it decides the calls. A master agent is
itself an AgentCompose agent — composition is recursive.

## Coordinator today

```ts
import { inProcess } from "@agentcompose/sdk";
import { Coordinator } from "@agentcompose/engine";

const team = new Coordinator([
  { name: "researcher", client: inProcess(researcher), config: { depth: "deep" } },
  { name: "summarizer", client: inProcess(summarizer) },
]);

const research = await team.call("researcher", goal);          // run one member
const summary  = await team.call("summarizer", research.parts); // wire output → input
const [a, b]   = await team.callMany([...]);                    // fan out in parallel
await team.close();
```

`Coordinator` is transport-agnostic — members may be `inProcess` or `spawnStdio`
(subprocess) clients; the code is identical.

## Try the demos

```bash
npm install            # links @agentcompose/sdk via file: for now

npm run demo:engine "AI agent interoperability"   # Engine: goal → plan → governed, checkpointed run
npm run demo:team   "AI agent interoperability"   # Coordinator: a master agent composing two members
```

The engine demo runs a deterministic two-step workflow (researcher → summarizer,
wired by variable reference) and streams plan/step/result events. See
[DESIGN.md](./DESIGN.md) for the architecture and the reasons behind it.

## Develop

```bash
npm install
npm test          # coordinator: chaining, progress forwarding, failure, parallel
npm run typecheck
```

> **Local linkage.** This repo depends on the SDK via `file:../sdk-typescript`
> while neither package is published. A proper release chain (publish the SDK,
> then depend on the published version) comes later.

## What's built, and what's next

**Built — the durable deterministic slice:** `Engine.run`/`resume`, the planner
loop, variable-reference DAG execution, dependency ordering, runtime governance
(allow/block/rewrite/approve), per-step checkpointing, durable suspend/resume for
human approval, fail-fast, and cancellation. Reference in-memory `CheckpointStore`
and an `authoredPlan` planner.

**Deferred (clearly):** a dynamic/LLM planner (the seam exists) and cross-run
**memory** (lands with that planner, its first consumer); parallel execution of
independent steps (the DAG already encodes the graph); retry/backoff; exactly-once
on resume (at-least-once today — the spec's idempotency keys are the path), and
cross-process concurrency control in the checkpoint store. See `DESIGN.md`.

## License

[Apache-2.0](./LICENSE)
