import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAgent, inProcess, AgentError, ErrorCodes, JsonRpcCodes } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";
import { Engine, AgentRegistry, authoredPlan } from "../src/index.ts";
import type { EngineEvent } from "../src/index.ts";
import { defaultRetryable, resolveRetry, computeBackoff } from "../src/retry.ts";

const textOf = (parts: Part[]) => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ").trim();
const goal = (t: string): Part[] => [{ kind: "text", text: t }];

async function collect(stream: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

/** An agent that fails its first `failures` invocations with `err`, then echoes. */
function flaky(id: string, failures: number, err: () => Error) {
  let calls = 0;
  return defineAgent({
    descriptor: { id, name: id, version: "1.0.0", capabilities: [{ id: "c", description: id }] },
    async handle(g) {
      calls += 1;
      if (calls <= failures) throw err();
      return [{ kind: "text", text: `ok:${textOf(g)}` }];
    },
  });
}

// Fast backoff so tests don't actually wait.
const fast = { initialMs: 1, maxMs: 2, jitter: false };

test("retries a transient failure and then succeeds", async () => {
  const reg = new AgentRegistry({ a: inProcess(flaky("a", 2, () => new AgentError(ErrorCodes.RateLimited, "rate limited"))) });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s0", agent: "a", input: [{ from: "goal" }] }]),
    retry: fast,
  });
  const events = await collect(engine.run(goal("hi"), { runId: "r1" }));

  const retries = events.filter((e) => e.type === "step-retry");
  assert.equal(retries.length, 2, "two retries before the third attempt succeeds");
  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.equal(textOf(result.parts), "ok:hi");
});

test("does not retry a non-transient (validation) failure — fails fast", async () => {
  const reg = new AgentRegistry({ a: inProcess(flaky("a", 5, () => new AgentError(JsonRpcCodes.InvalidParams, "bad input"))) });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s0", agent: "a", input: [{ from: "goal" }] }]),
    retry: { ...fast, maxAttempts: 4 },
  });
  const events = await collect(engine.run(goal("hi"), { runId: "r2" }));

  assert.equal(events.filter((e) => e.type === "step-retry").length, 0, "validation errors are not retried");
  assert.ok(events.some((e) => e.type === "step-failed"));
  assert.ok(events.some((e) => e.type === "error"));
});

test("gives up after maxAttempts on a persistently transient failure", async () => {
  const reg = new AgentRegistry({ a: inProcess(flaky("a", 99, () => new AgentError(ErrorCodes.RateLimited, "rate limited"))) });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s0", agent: "a", input: [{ from: "goal" }] }]),
    retry: { ...fast, maxAttempts: 3 },
  });
  const events = await collect(engine.run(goal("hi"), { runId: "r3" }));
  // 3 attempts => 2 retries, then fail.
  assert.equal(events.filter((e) => e.type === "step-retry").length, 2);
  assert.ok(events.some((e) => e.type === "error"));
});

test("falls back to the next agent when the primary exhausts its attempts", async () => {
  const reg = new AgentRegistry({
    primary: inProcess(flaky("primary", 99, () => new AgentError(ErrorCodes.RateLimited, "down"))),
    backup: inProcess(flaky("backup", 0, () => new Error("unused"))),
  });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s0", agent: "primary", input: [{ from: "goal" }], fallback: ["backup"], retry: { ...fast, maxAttempts: 2 } }]),
  });
  const events = await collect(engine.run(goal("hi"), { runId: "r4" }));

  const fb = events.find((e) => e.type === "step-fallback");
  assert.ok(fb && fb.type === "step-fallback" && fb.from === "primary" && fb.to === "backup");
  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.equal(textOf(result.parts), "ok:hi");
});

test("falls back immediately on a non-retryable primary error", async () => {
  const reg = new AgentRegistry({
    primary: inProcess(flaky("primary", 99, () => new AgentError(ErrorCodes.CapabilityNotSupported, "can't"))),
    backup: inProcess(flaky("backup", 0, () => new Error("unused"))),
  });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s0", agent: "primary", input: [{ from: "goal" }], fallback: ["backup"] }]),
  });
  const events = await collect(engine.run(goal("go"), { runId: "r5" }));
  assert.equal(events.filter((e) => e.type === "step-retry").length, 0, "non-retryable => no retry, straight to fallback");
  assert.ok(events.some((e) => e.type === "step-fallback"));
  assert.ok(events.some((e) => e.type === "result"));
});

test("a per-step timeout is surfaced as a retryable failure", async () => {
  const slow = defineAgent({
    descriptor: { id: "slow", name: "slow", version: "1.0.0", capabilities: [{ id: "c", description: "slow" }] },
    async handle() {
      await new Promise((r) => setTimeout(r, 50));
      return [{ kind: "text", text: "late" }];
    },
  });
  const reg = new AgentRegistry({ slow: inProcess(slow) });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s0", agent: "slow", input: [{ from: "goal" }] }]),
    retry: { ...fast, maxAttempts: 2, timeoutMs: 5 },
  });
  const events = await collect(engine.run(goal("hi"), { runId: "r6" }));
  // Timed out, classified retryable, retried once, timed out again -> fail.
  assert.ok(events.some((e) => e.type === "step-retry"), "timeout should retry");
  assert.ok(events.some((e) => e.type === "error" && /timed out/.test(e.error.message)));
});

test("classifier + backoff helpers behave", () => {
  assert.equal(defaultRetryable({ code: ErrorCodes.RateLimited, message: "x" }), true);
  assert.equal(defaultRetryable({ code: JsonRpcCodes.InternalError, message: "HTTP 503 upstream" }), true);
  assert.equal(defaultRetryable({ code: JsonRpcCodes.InvalidParams, message: "bad field" }), false);

  const r = resolveRetry({ initialMs: 100, factor: 2, maxMs: 1000, jitter: false }, undefined, defaultRetryable);
  assert.equal(computeBackoff(r, 1), 100);
  assert.equal(computeBackoff(r, 2), 200);
  assert.equal(computeBackoff(r, 5), 1000); // capped
});
