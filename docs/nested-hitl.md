# Nested HITL — Escalate a Required Decision to the Controller

> Design-of-record for how a delegated agent's need for input propagates **up** the
> delegation chain, the run **suspends** durably, and an answer is **routed back down**.
> This extends the engine's existing approval suspend/resume primitive; it does not
> replace it. All changes are SemVer-additive on the published `0.1.x` engine.

## The mental model: ask whoever controls me

There is **one** primitive, and it is **relative and recursive**:

> *A node escalates a required decision to its controller.*

- A **worker** (a delegated agent) that calls `requestInput` is asking **its caller —
  the engine** — not "the human." It has no idea a human exists.
- The **engine is a decider**. For each escalation it may **resolve** it locally (it is
  the master; it may already know), **escalate** to *its own* controller, or **deny** it.
- The chain bubbles until someone answers. The **human is simply the root** — the
  terminal decider, reached through the product. There is **no `ask-human`**: the engine
  is symmetric — as a callee it can be asked; as a caller (when wrapped via `asAgent()`)
  it asks up using the very same `requestInput`.

```
worker ──requestInput──► engine (decider) ──escalate──► higher engine ──escalate──► human (root)
   ▲                         │ resolve/deny                  │                          │
   └──── answer routed back down the same path ◄─────────────┴──────────────────────────┘
```

The wire vocabulary is unchanged and already caller-relative: `requestInput` /
`input-required` / `tasks/provideInput`. "Escalate to controller" is the *engine-side*
interpretation of that wire fact.

## Decision gates are the same thing

"Pick an idea", "approve the spend", "ship?" are **not** a special leaf agent. They are
**the master deciding it should not answer alone and escalating to its controller**. Same
primitive, initiated by the engine instead of a worker. Because such a gate does no work
of its own, it is trivially **replayable** — and therefore fully durable (see below).

## The durability crux

A parked handler is an **in-memory continuation** (the SDK holds a `pendingInput`
resolver in RAM). Surviving a process crash mid-escalation requires one of:

| Worker shape before the ask | Resume strategy | Durable across crash? |
|---|---|---|
| Stateless / cheap & replayable (gates, confirms, picks) | **replay**: re-run the step, feed the recorded answer | ✅ yes |
| Expensive / non-deterministic work already done | **hold-open**: keep the child parked in-process | ⚠️ in-process only |

The high-value app-pipeline gates are all the first row, so they are fully durable.

## Data model (additive)

```ts
// Identifies exactly who is waiting — the routing target.
export interface InputAddress {
  stepId: string;     // step in THIS run that is waiting
  askIndex: number;   // 0-based: nth requestInput within that step (supports multi-turn)
  // path?: string[];  // Tier 3: recursive stepId stack across asAgent() boundaries
  // taskId?: string;  // Tier 2: the live parked child (hold-open mode)
}

export type Pending =
  | { kind: "approval"; stepId: string; proposed?: Step }                 // unchanged
  | { kind: "input"; address: InputAddress; prompt?: Part[]; proposed?: Step };

// Snapshot gains the answers gathered so far, so a replay-resume is deterministic.
interface Snapshot { /* …existing… */ inputs?: Record<string, Part[]> }   // key = `${stepId}#${askIndex}`
```

`proposed` pins the exact reviewed step on resume (same rationale as approval: a
non-deterministic planner must not drift behind a suspension).

## The decider seam: `EscalationPolicy`

```ts
export type EscalationDecision =
  | { decision: "escalate" }                  // suspend the run → bubble to my controller
  | { decision: "resolve"; answer: Part[] }   // I answer it now, inline, no suspend
  | { decision: "deny"; reason: string };     // refuse → the step fails

export type EscalationPolicy = (req: {
  stepId: string; askIndex: number; prompt?: Part[]; ctx: RunContext;
}) => Promise<EscalationDecision> | EscalationDecision;

export const escalateAll: EscalationPolicy = () => ({ decision: "escalate" });
```

Injected per-engine (default `escalateAll`) and overridable per-run. "Involve the human
only when needed" = lower deciders `resolve` what they can; only the unresolved bubbles to
the root. **Mechanism is engine; policy is the product's.**

`asAgent()` supplies an `escalation` that bridges a nested worker's request to the
wrapper's **own** `ctx.requestInput` and returns `resolve` — exactly mirroring how it
already bridges approval. That makes the recursive "escalate to my controller" work
in-process today, with no engine suspend at the boundary.

## Control flow

### Worker mid-flight (replaces the fail-fast in `#attempt`)

On a child `status: input-required` with prompt `P`, ask index `i`, key `k = stepId#i`:

1. If `ctx` already has a recorded answer for `k` (we are replaying) → `provideInput(child, answer)`, `i++`, keep consuming the same stream.
2. Else consult `EscalationPolicy`:
   - **resolve** → record answer at `k`, `provideInput(child, answer)`, `i++`, continue.
   - **deny** → cancel child, fail the step.
   - **escalate** → cancel child, throw `EscalationSuspend{address, prompt, proposed}` up to `#drive`.

`EscalationSuspend` is rethrown unchanged through `#exec` (like `RunCanceled`) — it is not
a retryable step failure.

### Suspend (`#drive` catch)

Checkpoint `snapshot("suspended", { pending: { kind: "input", address, prompt, proposed } })`,
yield `{ type: "suspended", reason }`, return. The run is now durably parked at the engine
boundary; the live child has been released (replay mode).

### Resume (route-down)

```ts
interface ResumeOptions { /* …existing… */ inputs?: Record<string, Part[]> }  // key = `${stepId}#${askIndex}`
engine.provideInput(runId, parts, { stepId, askIndex? }): AsyncGenerator<EngineEvent>  // sugar
```

`resume` merges `inputs` into `ctx`, persists, then a **pin block** (parallel to the
approval pin) runs the pinned `proposed` step. On the re-run, `#attempt` finds the recorded
answer at `stepId#0` and feeds it instantly; a *second* ask (`#1`) with no recorded answer
suspends again at the next address. If resume carries no answer for the pending address, the
run simply **re-suspends**.

## Phasing

1. **Tier 1 (this change) — durable required-decision escalation, replay mode.**
   Generalize `Pending`→`input`; `EscalationPolicy` + `escalateAll`; `#attempt` replay/
   resolve/deny/escalate; `Snapshot.inputs`; `resume({inputs})` + `provideInput` sugar;
   `asAgent()` escalation bridge. Engine stays green; covers every app-pipeline gate.
2. **Tier 2 — worker mid-flight clarify (hold-open).** Keep an expensive child parked
   in-process; `address.taskId`; continue the same stream on `provideInput`. In-process
   durability boundary documented.
3. **Tier 3 — recursive route-down. ✅ covered by replay.** A deep worker's escalation
   bubbles automatically: the inner engine's `asAgent()` bridge raises the inner wrapper's
   `input-required`, the outer engine's executor sees its child go `input-required` and
   escalates per the *outer* policy, suspending the outer run durably. Resume replays the
   outer step (re-runs the inner engine) and feeds the recorded answer into the inner
   wrapper — each layer handles its own level, so no explicit `address.path` stack is
   needed under the replay model. (`address.path` only becomes necessary for *hold-open*
   recursion, which rides on Tier 2/4.)
4. **Tier 2 — worker mid-flight clarify (hold-open). Deferred — no consumer yet.** Keeping
   an expensive child parked in-process avoids repeating pre-ask work and is the *correct*
   choice for side-effecting workers (where replay would re-run a purchase/publish). But it
   is in-process-only and splits the run contract (a hold-open suspend must not end the
   event stream), so it waits for a real side-effecting worker to justify it.
5. **Tier 4 — cross-process durable mid-flight.** Deterministic-replay or self-durable
   workers; only when a real worker must survive a crash mid-clarify.

## Deferred (explicit)

- Cross-process durability of an *expensive* mid-flight worker (Tier 4).
- Concurrency fencing: a real `CheckpointStore` needs a per-`runId` lock so two resumers
  cannot race a suspended run (already flagged in `checkpoint.ts`).
- Parallel suspended lanes (rides on the deferred parallel executor; addresses already
  disambiguate lanes).
