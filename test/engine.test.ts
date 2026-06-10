import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAgent, inProcess } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";
import {
  Engine,
  AgentRegistry,
  authoredPlan,
  approveWhen,
  InMemoryCheckpointStore,
} from "../src/index.ts";
import type { EngineEvent, Step } from "../src/index.ts";

const textOf = (parts: Part[]) => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ");
const goal = (t: string): Part[] => [{ kind: "text", text: t }];

const upper = defineAgent({
  descriptor: { id: "t.upper", name: "Upper", version: "1.0.0", capabilities: [{ id: "u", description: "uppercase" }] },
  async handle(g, ctx) {
    ctx.progress(50, "upper");
    return [{ kind: "text", text: textOf(g).toUpperCase() }];
  },
});

const exclaim = defineAgent({
  descriptor: { id: "t.exclaim", name: "Exclaim", version: "1.0.0", capabilities: [{ id: "e", description: "add !" }] },
  async handle(g) {
    return [{ kind: "text", text: textOf(g) + "!" }];
  },
});

const boom = defineAgent({
  descriptor: { id: "t.boom", name: "Boom", version: "1.0.0", capabilities: [{ id: "b", description: "fail" }] },
  async handle() {
    throw new Error("kaboom");
  },
});

const registry = () =>
  new AgentRegistry({ upper: inProcess(upper), exclaim: inProcess(exclaim), boom: inProcess(boom) });

const chain = (): Step[] => [
  { id: "a", agent: "upper", input: [{ from: "goal" }] },
  { id: "b", agent: "exclaim", input: [{ from: "step", ref: "a" }] },
];

async function collect(stream: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

test("runs a deterministic workflow, wiring output → input by variable ref", async () => {
  const engine = new Engine({ registry: registry(), planner: authoredPlan(chain()) });
  const events = await collect(engine.run(goal("hello"), { runId: "r1" }));

  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.equal(textOf(result.parts).trim(), "HELLO!");

  const order = events.filter((e) => e.type === "step-completed").map((e: any) => e.stepId);
  assert.deepEqual(order, ["a", "b"]);
});

test("resumes from the last checkpoint in a fresh Engine, skipping completed steps", async () => {
  const checkpoints = new InMemoryCheckpointStore();
  let runs = 0;
  const counting = defineAgent({
    descriptor: { id: "t.count", name: "Count", version: "1.0.0", capabilities: [{ id: "c", description: "count" }] },
    async handle(g) {
      runs++;
      return [{ kind: "text", text: textOf(g).toUpperCase() }];
    },
  });

  // First Engine runs step "a" only, then "blocks" before "b" via a governor that
  // suspends "b" — simulating a crash boundary after the first checkpoint.
  const reg = new AgentRegistry({ a: inProcess(counting), b: inProcess(exclaim) });
  const steps: Step[] = [
    { id: "a", agent: "a", input: [{ from: "goal" }] },
    { id: "b", agent: "b", input: [{ from: "step", ref: "a" }] },
  ];
  const engine1 = new Engine({
    registry: reg,
    planner: authoredPlan(steps),
    checkpoints,
    governor: approveWhen((s) => s.id === "b"), // suspend before b (no onApproval → durable suspend)
  });
  const first = await collect(engine1.run(goal("hi"), { runId: "r2" }));
  assert.ok(first.some((e) => e.type === "suspended"));
  assert.equal(runs, 1, "step a ran once before suspend");

  const snap = await checkpoints.load("r2");
  assert.equal(snap?.status, "suspended");
  assert.deepEqual(Object.keys(snap!.outputs), ["a"], "only a is checkpointed");

  // Fresh Engine, same store: resume with approval for b. a must NOT re-run.
  const engine2 = new Engine({ registry: reg, planner: authoredPlan(steps), checkpoints, governor: approveWhen((s) => s.id === "b") });
  const second = await collect(engine2.resume("r2", { approvals: { b: true } }));
  const result = second.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.equal(textOf(result.parts).trim(), "HI!");
  assert.equal(runs, 1, "step a was NOT re-run on resume");
});

test("fail-fast: a failing step emits step-failed and the run errors", async () => {
  const steps: Step[] = [
    { id: "a", agent: "upper", input: [{ from: "goal" }] },
    { id: "x", agent: "boom", input: [{ from: "step", ref: "a" }] },
  ];
  const engine = new Engine({ registry: registry(), planner: authoredPlan(steps) });
  const events = await collect(engine.run(goal("hello"), { runId: "r3" }));

  assert.ok(events.some((e) => e.type === "step-failed" && (e as any).stepId === "x"));
  assert.ok(events.some((e) => e.type === "error"));
  assert.ok(!events.some((e) => e.type === "result"));

  const snap = await engine.snapshot("r3");
  assert.equal(snap?.status, "failed");
  assert.ok(snap?.error?.message.includes("kaboom") || snap?.error);
});

test("governance can block a step, failing the run before it executes", async () => {
  let ran = false;
  const watch = defineAgent({
    descriptor: { id: "t.watch", name: "Watch", version: "1.0.0", capabilities: [{ id: "w", description: "watch" }] },
    async handle(g) {
      ran = true;
      return g;
    },
  });
  const reg = new AgentRegistry({ watch: inProcess(watch) });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s", agent: "watch", input: [{ from: "goal" }] }]),
    governor: () => ({ decision: "block", reason: "not allowed in test" }),
  });
  const events = await collect(engine.run(goal("x"), { runId: "r4" }));
  assert.equal(ran, false, "blocked step never executed");
  assert.ok(events.some((e) => e.type === "step-failed"));
});

test("inline onApproval approves without suspending", async () => {
  const asked: string[] = [];
  const engine = new Engine({
    registry: registry(),
    planner: authoredPlan(chain()),
    governor: approveWhen((s) => s.id === "b"),
  });
  const events = await collect(
    engine.run(goal("hello"), { runId: "r5", onApproval: ({ step }) => (asked.push(step.id), true) }),
  );
  assert.deepEqual(asked, ["b"]);
  assert.ok(events.some((e) => e.type === "result"));
  assert.ok(!events.some((e) => e.type === "suspended"));
});
