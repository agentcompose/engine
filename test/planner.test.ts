import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAgent, inProcess } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";
import {
  Engine,
  AgentRegistry,
  dynamicPlanner,
  ScriptedDecider,
  approveWhen,
  InMemoryCheckpointStore,
} from "../src/index.ts";
import type { Action, DecisionRequest, EngineEvent } from "../src/index.ts";
import { openAICompatibleDecider } from "../src/adapters/openai-compatible.ts";

const textOf = (parts: Part[]) => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ").trim();
const goal = (t: string): Part[] => [{ kind: "text", text: t }];

const echo = (id: string, name: string, transform: (s: string) => string) =>
  defineAgent({
    descriptor: { id, name, version: "1.0.0", capabilities: [{ id: "c", description: name }] },
    async handle(g) {
      return [{ kind: "text", text: transform(textOf(g)) }];
    },
  });

const upper = echo("t.upper", "Upper", (s) => s.toUpperCase());
const exclaim = echo("t.exclaim", "Exclaim", (s) => s + "!");

async function collect(stream: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// A re-derivable brain: a pure function of how many observations exist. This is what
// keeps resume correct — restored observations yield the same decisions.
const brain = (req: DecisionRequest): Action => {
  switch (req.observations.length) {
    case 0:
      return { kind: "call", agent: "upper", use: ["goal"] };
    case 1:
      return { kind: "call", agent: "exclaim", use: ["step-0"] };
    default:
      return { kind: "finish", use: ["step-1"] };
  }
};

const registry = () => new AgentRegistry({ upper: inProcess(upper), exclaim: inProcess(exclaim) });

test("dynamic planner drives a multi-step run from a goal", async () => {
  const reg = registry();
  const engine = new Engine({ registry: reg, planner: dynamicPlanner({ decider: new ScriptedDecider(brain), registry: reg }) });
  const events = await collect(engine.run(goal("hello"), { runId: "d1" }));

  const order = events.filter((e) => e.type === "step-completed").map((e: any) => e.stepId);
  assert.deepEqual(order, ["step-0", "step-1"]);
  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.equal(textOf(result.parts), "HELLO!");
});

test("a dynamic run re-derives on resume without re-running completed steps", async () => {
  let upperRuns = 0;
  const counting = defineAgent({
    descriptor: { id: "t.c", name: "Upper", version: "1.0.0", capabilities: [{ id: "c", description: "upper" }] },
    async handle(g) {
      upperRuns++;
      return [{ kind: "text", text: textOf(g).toUpperCase() }];
    },
  });
  const reg = new AgentRegistry({ upper: inProcess(counting), exclaim: inProcess(exclaim) });
  const checkpoints = new InMemoryCheckpointStore();
  const planner = () => dynamicPlanner({ decider: new ScriptedDecider(brain), registry: reg });

  // Suspend before step-1 (durable HITL) → only step-0 runs, then checkpoint.
  const engine1 = new Engine({ registry: reg, planner: planner(), checkpoints, governor: approveWhen((s) => s.id === "step-1") });
  const first = await collect(engine1.run(goal("hi"), { runId: "d2" }));
  assert.ok(first.some((e) => e.type === "suspended"));
  assert.equal(upperRuns, 1);

  // Fresh engine + planner, same store: resume with approval. step-0 must NOT re-run;
  // the planner re-derives step-1 from the restored single observation.
  const engine2 = new Engine({ registry: reg, planner: planner(), checkpoints, governor: approveWhen((s) => s.id === "step-1") });
  const second = await collect(engine2.resume("d2", { approvals: { "step-1": true } }));
  const result = second.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.equal(textOf(result.parts), "HI!");
  assert.equal(upperRuns, 1, "step-0 was not re-executed on resume");
});

test("dynamic planner rejects an unregistered agent choice", async () => {
  const reg = registry();
  const planner = dynamicPlanner({ decider: new ScriptedDecider([{ kind: "call", agent: "ghost", use: ["goal"] }]), registry: reg });
  const engine = new Engine({ registry: reg, planner });
  const events = await collect(engine.run(goal("x"), { runId: "d3" }));
  assert.ok(events.some((e) => e.type === "error" && (e as any).error.message.includes("ghost")));
});

test("dynamic planner enforces maxRounds", async () => {
  const reg = registry();
  // A brain that never finishes.
  const planner = dynamicPlanner({
    decider: new ScriptedDecider(() => ({ kind: "call", agent: "upper", use: ["goal"] })),
    registry: reg,
    maxRounds: 2,
  });
  const engine = new Engine({ registry: reg, planner });
  const events = await collect(engine.run(goal("x"), { runId: "d4" }));
  assert.ok(events.some((e) => e.type === "error" && (e as any).error.message.includes("maxRounds")));
});

test("openAICompatibleDecider maps a model JSON response to an Action (stub fetch)", async () => {
  const calls: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const content = JSON.stringify({ kind: "call", agent: "upper", instruction: "go", use: ["goal"] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const decider = openAICompatibleDecider({ baseUrl: "https://gw.example/v1/", apiKey: "k", model: "m", fetchImpl: fakeFetch });
  const action = await decider.decide({ goal: "hello", observations: [], choices: [{ name: "upper", title: "Upper", description: "uppercase" }] });

  assert.deepEqual(action, { kind: "call", agent: "upper", instruction: "go", use: ["goal"] });
  assert.equal(calls[0].url, "https://gw.example/v1/chat/completions"); // trailing slash trimmed
  assert.equal(calls[0].body.model, "m");
});

test("openAICompatibleDecider surfaces HTTP errors", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  const decider = openAICompatibleDecider({ baseUrl: "https://gw/v1", apiKey: "k", model: "m", fetchImpl: fakeFetch });
  await assert.rejects(
    () => decider.decide({ goal: "g", observations: [], choices: [] }),
    /HTTP 401/,
  );
});

test("openAICompatibleDecider parses a streamed (text/event-stream) response", async () => {
  // Some gateways stream by default even when stream was not requested.
  const fakeFetch = (async () => {
    const d1 = JSON.stringify({ choices: [{ delta: { content: '{"kind":"fin' } }] });
    const d2 = JSON.stringify({ choices: [{ delta: { content: 'ish","text":"hi"}' } }] });
    const body = `data: ${d1}\n\ndata: ${d2}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const decider = openAICompatibleDecider({ baseUrl: "https://gw/v1", apiKey: "k", model: "m", fetchImpl: fakeFetch });
  const action = await decider.decide({ goal: "g", observations: [], choices: [] });
  assert.deepEqual(action, { kind: "finish", use: undefined, text: "hi" });
});

test("dynamicPlanner tolerates a model that uses the 'GOAL' token (any case)", async () => {
  const decider = new ScriptedDecider((): Action => ({ kind: "finish", use: ["GOAL"] }));
  const reg = new AgentRegistry({ upper: inProcess(upper) });
  const engine = new Engine({ registry: reg, planner: dynamicPlanner({ decider, registry: reg }) });
  const events = await collect(engine.run(goal("echo me"), { runId: "caseg" }));
  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.equal(textOf(result.parts), "echo me");
});
