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
| **`Engine`** | the **brain** — accept a *goal*, produce a *plan* (deterministic workflow **or** dynamically), run it through the Coordinator | 🚧 next |

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

## Try the demo

```bash
npm install            # links @agentcompose/sdk via file: for now
npm run demo:team "AI agent interoperability"
```

A master "Research Team" agent (itself an AgentCompose agent) coordinates a
researcher → summarizer, forwarding their progress and streaming the final summary.

## Develop

```bash
npm install
npm test          # coordinator: chaining, progress forwarding, failure, parallel
npm run typecheck
```

> **Local linkage.** This repo depends on the SDK via `file:../sdk-typescript`
> while neither package is published. A proper release chain (publish the SDK,
> then depend on the published version) comes later.

## What's next (the Engine brain)

`Engine.run(goal, { agents, onApproval, memory })` → an event stream of plan steps
and results. The first slice executes an **explicit plan** over registered agents
(deterministic workflow); a **planner** that generates plans from a goal, plus
memory and human-in-the-loop (via the `input-required` state), follow.

## License

[Apache-2.0](./LICENSE)
