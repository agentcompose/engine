# Engine — Potential Issues (code review)

> Working notes from a code review of `@agentcompose/engine` (the brain + chassis).
> Status at review: spec validates, SDK 8/8, engine 15/15, `tsc` clean.
> Nothing here is committed — it's a punch-list, ordered by severity.
>
> **RESOLUTION (2026-06-10):** all nine verified against the code and addressed.
> Engine now 23/23, `tsc` clean. Per-item resolution notes inline (✅). Deferred
> follow-ups (full child-input propagation, parallelism, real persistence) remain on
> the roadmap in DESIGN.md.

---

## 🔴 1. Durable approval does not pin the approved step's content

**Where:** `src/engine.ts` `#govern` (suspend path) + `#drive` (resume re-plans);
`src/context.ts` `snapshot()`; `src/types.ts` `Pending`.

**What happens:** when a run suspends for approval, the checkpoint stores only
`pending: { kind: "approval", stepId }` — **not** the step's `agent` / `input` /
`instruction`. On `resume()`, `#drive` calls `planner.next()` again to *re-derive*
the step.

**Why it's a problem:** `authoredPlan` is deterministic, so re-deriving is safe.
But the real `openAICompatibleDecider` is **non-deterministic** (even at
`temperature: 0` a model can drift). So a human can approve `step-1` =
*"call exclaim on step-0"*, and on resume the planner re-derives a **different**
action under the **same id** — which the engine then executes without review.
Approval is keyed by id, but the *content* behind that id is not bound to what was
approved. For a human-in-the-loop **safety gate**, that's the wrong invariant.

The code comments in `planner.ts` flag re-derivability as "a seam-level concern to
address when that planner lands" — but the non-deterministic planner **has now
landed**, so this is live, not theoretical.

**Suggested fix:** persist the proposed `Step` in the suspend checkpoint (e.g. put
the full step on `Pending`, or add `proposed?: Step` to the snapshot) and execute
*that exact step* on resume instead of re-deriving it. Same reasoning applies to
crash-resume in the middle of a dynamic plan.

**✅ Resolved.** `Pending` now carries `proposed?: Step`; the suspend checkpoint pins
the reviewed step, and `#drive` executes that exact step on resume (bypassing
re-derivation) before resuming the planner loop. Regression test:
*"#1 durable approval pins the reviewed step against planner drift"*.

---

## 🔴 2. A sub-agent entering `input-required` deadlocks the run

**Where:** `src/engine.ts` `#exec` (the `for await (const ev of client.events(...))`
loop); interacts with the SDK's `subscribe()` in `sdk-typescript/src/agent.ts`.

**What happens:** `#exec` drains `client.events(taskId)` until the stream closes.
Per the SDK, the event channel only closes on a **terminal** status — and
`input-required` is **non-terminal**. The engine never calls `provideInput`.

**Why it's a problem:** if any sub-agent calls `ctx.requestInput()`, the engine's
`for await` loop **never returns** and the run hangs silently. The engine's own
HITL (governor approval) works, but a *child agent's* `input-required` is not
bridged upward. (Same gap exists in `coordinator.ts` `call()`.)

**Suggested fix:** detect `ev.type === "status" && ev.state === "input-required"`
in the loop and either (a) propagate it as a new suspend / `Pending` reason the
product answers on `resume()`, or (b) fail fast with a clear error until child
input is supported. Today it just deadlocks.

**✅ Resolved (option b).** Both `#exec` and `coordinator.call` now detect a child
`input-required`, cancel the child task, and fail fast with a clear
`CapabilityNotSupported` error instead of hanging. Full upward propagation (option a)
needs durable cross-process child state — deferred, noted in DESIGN.md. Regression
test: *"#2 a sub-agent requesting input fails fast instead of hanging"*.

---

## 🟠 3. Per-step config leaks across steps that share an agent

**Where:** `src/engine.ts` `#exec`: `if (step.config) await client.configure(step.config)`.

**What happens:** `configure()` is called **only when `step.config` is set**. The
SDK runtime keeps the last effective config on the (shared, registry-held) client.

**Why it's a problem:**
- Step A configures agent X with `{ depth: "deep" }`.
- Step B uses agent X with **no** config, expecting defaults — but inherits
  `{ depth: "deep" }`, because nothing resets it.

The inline comment only warns about *concurrent* reuse; the **sequential leak**
(no reset to defaults) is the real bug and isn't called out.

**Suggested fix:** when a step has no `config`, re-apply defaults (call
`configure({})`), or hand each step a per-use configured client instance (the spec
models "one configured instance").

**✅ Resolved.** `#exec` now calls `client.configure(step.config ?? {})` every step,
resetting to declared defaults before layering the step's own config. Regression
test: *"#3 per-step config does not leak across steps sharing an agent"*.

---

## 🟠 4. An auto-generated `runId` is unrecoverable (can't resume)

**Where:** `src/engine.ts` `run()` (`opts.runId ?? crypto.randomUUID()`); `EngineEvent`
in `src/types.ts`.

**What happens:** if the caller doesn't pass `runId`, one is generated but **never
surfaced** — no run-level event carries it.

**Why it's a problem:** the caller can't later `resume(runId)` or `snapshot(runId)`
because they never learned the id.

**Suggested fix:** surface `runId` — e.g. emit a first `run-started` event carrying
it, or return it alongside the event stream.

**✅ Resolved.** `run()` and `resume()` now emit a leading `run-started` event
carrying the `runId`. Regression test: *"run() surfaces a generated runId via a
run-started event"*.

---

## 🟡 5. "Parallelize ready steps for free" is not realized

**Where:** `src/engine.ts` `#order` (topo-sort) + `#drive` (sequential `for...of`).

`#order` correctly topologically sorts and detects cycles, but `#drive` executes
strictly **sequentially**. The variable-ref DAG encodes parallelism; the executor
linearizes it. Fine for v1, but `DESIGN.md`'s "the executor can parallelize ready
steps for free" is not yet true — worth a note so it isn't oversold.

**✅ Resolved (doc).** DESIGN.md reworded to "the executor *can* parallelize ready
steps (deferred — execution is sequential in dependency order today)." Parallel
execution itself stays a Tier-B roadmap item.

---

## 🟡 6. Failed-path double-save + dead code

**Where:** `src/engine.ts` `#drive` catch block.

```ts
await this.#checkpoints.save(ctx.runId, ctx.snapshot("failed", { result: undefined }));
const failed = ctx.snapshot("failed");
await this.#checkpoints.save(ctx.runId, { ...failed, error });
```

The first `save` is immediately overwritten by the second, and
`{ result: undefined }` is ignored by `snapshot()`. Harmless, but should be a
single save.

**✅ Resolved.** Collapsed to one `save` of `{ ...ctx.snapshot("failed"), error }`.

---

## 🟡 7. `rewrite` verdicts bypass re-ordering / re-validation

**Where:** `src/engine.ts` `#govern` (`rewrite` returns `verdict.step`) relative to
`#order`.

A governor that rewrites `step.id` or its `input` bindings runs **after** `#order`
has been computed; the rewritten step isn't re-checked for dependency validity or
re-ordered. Low risk (the governor is trusted product code), but worth either a
guard or a documented constraint: *a rewrite MUST preserve `id` and dependencies.*

**✅ Resolved.** `#govern` now rejects a rewrite that changes `step.id` (clear
error), enforcing the identity constraint; new step-refs must already be satisfied
(`resolveBindings` throws otherwise) — documented inline.

---

## 🟡 8. Brittle JSON scraping in the model adapter

**Where:** `src/adapters/openai-compatible.ts` `parseAction` + `response_format`
(`strict: false`).

`parseAction` extracts JSON with a greedy `/\{[\s\S]*\}/` and `strict: false`
schema. If a model emits braces in prose or multiple objects, the greedy match can
capture the wrong span. The parsed object's `kind` is checked, but `agent` / `use`
shapes are not validated here (the planner does check `registry.has(agent)` later).

**Suggested fix:** prefer the provider's strict structured-output mode, and/or
validate the parsed object against `ACTION_SCHEMA` (e.g. via Ajv) before returning.

**✅ Resolved (zero-dep).** `parseAction` now tries a direct `JSON.parse` first
(the strict/structured happy path), falls back to brace extraction only on failure,
and routes through `validateAction` which checks `kind`/`agent`/`use`/`text` shapes
and normalizes the object (dropping stray keys). Kept `strict: false` for gateway
breadth; validation is client-side. (No Ajv — the adapter stays dependency-free.)

---

## 🟡 9. `partsToText` silently drops non-text parts

**Where:** `src/model.ts` `partsToText` (used to build observations for the decider).

Only `text` and `data` parts survive; `file` parts are dropped. A sub-agent that
produces a file artifact contributes nothing to the decider's observations.
Acceptable for a text-first v1 — just note the limitation.

**✅ Resolved.** `partsToText` now renders a `file` part as a `[file: name|mime|uri]`
placeholder, so the decider knows an artifact exists (bytes remain out of band for a
text decider — the documented limitation).

---

## Carried over (not engine-specific, still relevant)

- **SDK is `0.0.0` / unpublished** — gates the whole ecosystem; the engine depends
  on it via `file:`.
- **SDK self-conformance gaps:** shallow `applyDefaults` (top-level only), no
  inbound JSON-RPC param validation against the published schemas, missing secret
  resolves to `null` silently, no task-retention eviction (in-memory map grows).
- **Typed capability I/O still absent (Scope B).** The dynamic planner chooses
  agents by **natural-language** capability descriptions fed to the model — a
  reasonable interim, but composition is still untyped (LLM judgment, not contract
  matching).
- **Agent-side `provider` injection unproven.** The engine's *planner* routes
  through an OpenAI-compatible `baseUrl`, but a reused **agent** running a real
  model on the consumer's endpoint still has no working reference (example agents
  are stubs).

---

## Suggested order to address

1. Pin approved/suspended steps in the checkpoint (#1) — safety; do before any real
   LLM planner use.
2. Handle child `input-required` in `#exec` (#2) — remove the deadlock.
3. Reset config between steps sharing an agent (#3).
4. Surface `runId` (#4).
5. Then the tidy-ups (#5–#9) as convenient.

---

## Status: all addressed ✅

#1–#9 resolved (see inline notes); engine 23/23, `tsc` clean, demos pass. The
"carried over" items remain open by design and live on the DESIGN.md roadmap:
SDK publish, SDK self-conformance hardening, typed capability I/O (Scope B), and a
real model-backed reference agent.
