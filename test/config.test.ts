import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAgent, inProcess } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";
import { Engine, AgentRegistry, authoredPlan } from "../src/index.ts";
import type { EngineEvent } from "../src/index.ts";

const textOf = (parts: Part[]) => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ").trim();
const goal = (t: string): Part[] => [{ kind: "text", text: t }];

async function collect(stream: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// Echoes its effective `tag` config so we can observe what config a step ran with.
const tagger = defineAgent({
  descriptor: {
    id: "t.tagger",
    name: "Tagger",
    version: "1.0.0",
    capabilities: [{ id: "c", description: "echo tag" }],
    configSchema: { type: "object", properties: { tag: { type: "string", default: "schema-default" } } },
  },
  async handle(_g, ctx) {
    return [{ kind: "text", text: `tag=${String(ctx.config.tag)}` }];
  },
});

const tagOf = (events: EngineEvent[], stepId: string) => {
  const e = events.find((ev) => ev.type === "step-completed" && ev.stepId === stepId);
  return e && e.type === "step-completed" ? textOf(e.parts) : undefined;
};

test("instance (registry) config survives steps that don't set step.config", async () => {
  const reg = new AgentRegistry({ t: { client: inProcess(tagger), config: { tag: "instance" } } });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s0", agent: "t", input: [{ from: "goal" }] }]),
  });
  const events = await collect(engine.run(goal("hi"), { runId: "cfg1" }));
  assert.equal(tagOf(events, "s0"), "tag=instance", "base config is applied, not wiped to schema default");
});

test("step.config overlays instance config, and the overlay does not leak to later steps", async () => {
  const reg = new AgentRegistry({ t: { client: inProcess(tagger), config: { tag: "instance" } } });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([
      { id: "s0", agent: "t", input: [{ from: "goal" }] },
      { id: "s1", agent: "t", input: [{ from: "step", ref: "s0" }], config: { tag: "overlay" } },
      { id: "s2", agent: "t", input: [{ from: "step", ref: "s1" }] },
    ]),
  });
  const events = await collect(engine.run(goal("hi"), { runId: "cfg2" }));
  assert.equal(tagOf(events, "s0"), "tag=instance", "s0: base config");
  assert.equal(tagOf(events, "s1"), "tag=overlay", "s1: step config overlays base");
  assert.equal(tagOf(events, "s2"), "tag=instance", "s2: overlay reset, base reapplied");
});

test("with no instance config, schema default applies", async () => {
  const reg = new AgentRegistry({ t: inProcess(tagger) });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([{ id: "s0", agent: "t", input: [{ from: "goal" }] }]),
  });
  const events = await collect(engine.run(goal("hi"), { runId: "cfg3" }));
  assert.equal(tagOf(events, "s0"), "tag=schema-default");
});
