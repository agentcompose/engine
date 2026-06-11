import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAgent, inProcess } from "@agentcompose/sdk";
import type { Part, TaskEvent } from "@agentcompose/sdk";
import { Engine, AgentRegistry, authoredPlan, asAgent, approveWhen } from "../src/index.ts";

const textOf = (parts: Part[]) => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ").trim();
const goal = (t: string): Part[] => [{ kind: "text", text: t }];

const echo = (id: string, name: string, fn: (s: string) => string) =>
  defineAgent({
    descriptor: { id, name, version: "1.0.0", capabilities: [{ id: "c", description: name }] },
    async handle(g, ctx) {
      ctx.progress(50, name);
      return [{ kind: "text", text: fn(textOf(g)) }];
    },
  });

const upper = echo("t.upper", "Upper", (s) => s.toUpperCase());
const exclaim = echo("t.exclaim", "Exclaim", (s) => s + "!");

// An inner engine: upper → exclaim, wired by variable reference.
function innerEngine() {
  const reg = new AgentRegistry({ upper: inProcess(upper), exclaim: inProcess(exclaim) });
  const planner = authoredPlan([
    { id: "a", agent: "upper", input: [{ from: "goal" }] },
    { id: "b", agent: "exclaim", input: [{ from: "step", ref: "a" }] },
  ]);
  return new Engine({ registry: reg, planner });
}

test("asAgent: an engine satisfies the agent contract (describe + run)", async () => {
  const client = inProcess(
    asAgent({
      descriptor: { id: "x.inner", name: "Inner", version: "1.0.0", capabilities: [{ id: "c", description: "upper then bang" }] },
      engine: innerEngine(),
    }),
  );

  const d = await client.describe();
  assert.equal(d.id, "x.inner");

  const task = await client.submit(goal("hello"));
  const events: TaskEvent[] = [];
  for await (const ev of client.events(task.id)) events.push(ev);
  const final = await client.get(task.id);

  assert.equal(final.state, "completed");
  assert.equal(textOf(final.result?.parts ?? []), "HELLO!");
  // Inner step progress is forwarded out through the agent surface.
  assert.ok(events.some((e) => e.type === "progress"));
  await client.close();
});

test("asAgent: an engine runs as a STEP inside another engine (recursion)", async () => {
  // Inner engine, wrapped as an agent, registered as a worker in an outer engine.
  const inner = inProcess(
    asAgent({
      descriptor: { id: "x.inner", name: "Inner", version: "1.0.0", capabilities: [{ id: "c", description: "upper then bang" }] },
      engine: innerEngine(),
    }),
  );
  const prefix = echo("t.prefix", "Prefix", (s) => "» " + s);

  const outerReg = new AgentRegistry({ inner, prefix: inProcess(prefix) });
  const outer = new Engine({
    registry: outerReg,
    planner: authoredPlan([
      { id: "deep", agent: "inner", input: [{ from: "goal" }] },
      { id: "wrap", agent: "prefix", input: [{ from: "step", ref: "deep" }] },
    ]),
  });

  const out: Part[] = [];
  for await (const ev of outer.run(goal("hi"), { runId: "rec1" })) {
    if (ev.type === "result") out.push(...ev.parts);
  }
  assert.equal(textOf(out), "» HI!");
  await outerReg.close();
});

test("asAgent: engine failure surfaces as agent failure", async () => {
  const boom = defineAgent({
    descriptor: { id: "t.boom", name: "Boom", version: "1.0.0", capabilities: [{ id: "b", description: "fail" }] },
    async handle() {
      throw new Error("inner kaboom");
    },
  });
  const reg = new AgentRegistry({ boom: inProcess(boom) });
  const engine = new Engine({ registry: reg, planner: authoredPlan([{ id: "x", agent: "boom", input: [{ from: "goal" }] }]) });

  const client = inProcess(
    asAgent({ descriptor: { id: "x.f", name: "F", version: "1.0.0", capabilities: [{ id: "c", description: "fails" }] }, engine }),
  );
  const task = await client.submit(goal("x"));
  for await (const _ of client.events(task.id)) void _;
  const final = await client.get(task.id);
  assert.equal(final.state, "failed");
  assert.ok(final.error?.message.includes("kaboom"));
  await client.close();
});

test("asAgent: governor approval bridges to the agent's input-required state", async () => {
  const engine = new Engine({
    registry: new AgentRegistry({ upper: inProcess(upper) }),
    planner: authoredPlan([{ id: "a", agent: "upper", input: [{ from: "goal" }] }]),
    governor: approveWhen((s) => s.id === "a"),
  });
  const client = inProcess(
    asAgent({ descriptor: { id: "x.hitl", name: "Hitl", version: "1.0.0", capabilities: [{ id: "c", description: "needs ok" }] }, engine }),
  );

  const task = await client.submit(goal("hello"));
  // Drive events in the background; wait until the task asks for input.
  const seen: TaskEvent[] = [];
  const pump = (async () => {
    for await (const ev of client.events(task.id)) seen.push(ev);
  })();

  // Poll for input-required, then approve.
  let state = (await client.get(task.id)).state;
  while (state !== "input-required" && state !== "failed" && state !== "completed") {
    await new Promise((r) => setTimeout(r, 5));
    state = (await client.get(task.id)).state;
  }
  assert.equal(state, "input-required");

  await client.provideInput(task.id, [{ kind: "text", text: "yes" }]);
  await pump;
  const final = await client.get(task.id);
  assert.equal(final.state, "completed");
  assert.equal(textOf(final.result?.parts ?? []), "HELLO");
  await client.close();
});

test("asAgent: a nested worker's escalation bridges to the wrapper's input-required", async () => {
  // An inner worker that escalates (requestInput) mid-run.
  const clarifier = defineAgent({
    descriptor: { id: "t.clar", name: "Clarifier", version: "1.0.0", capabilities: [{ id: "c", description: "asks" }] },
    async handle(g, ctx) {
      const ans = await ctx.requestInput([{ kind: "text", text: "which?" }]);
      return [{ kind: "text", text: `${textOf(g)}/${textOf(ans)}` }];
    },
  });
  const engine = new Engine({
    registry: new AgentRegistry({ clar: inProcess(clarifier) }),
    planner: authoredPlan([{ id: "a", agent: "clar", input: [{ from: "goal" }] }]),
  });
  const client = inProcess(
    asAgent({ descriptor: { id: "x.esc", name: "Esc", version: "1.0.0", capabilities: [{ id: "c", description: "bridges" }] }, engine }),
  );

  const task = await client.submit(goal("pick"));
  const seen: TaskEvent[] = [];
  const pump = (async () => {
    for await (const ev of client.events(task.id)) seen.push(ev);
  })();

  let state = (await client.get(task.id)).state;
  while (state !== "input-required" && state !== "failed" && state !== "completed") {
    await new Promise((r) => setTimeout(r, 5));
    state = (await client.get(task.id)).state;
  }
  assert.equal(state, "input-required");
  // The worker's prompt bubbled all the way up to the wrapper's input-required.
  const ask = seen.find((e) => e.type === "status" && e.state === "input-required") as any;
  assert.equal(textOf(ask.prompt), "which?");

  await client.provideInput(task.id, [{ kind: "text", text: "B" }]);
  await pump;
  const final = await client.get(task.id);
  assert.equal(final.state, "completed");
  assert.equal(textOf(final.result?.parts ?? []), "pick/B");
  await client.close();
});
