import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAgent, inProcess } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";
import { Coordinator } from "../src/index.ts";
import type { EventSink } from "../src/index.ts";

const textOf = (parts: Part[]) => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ");

const upper = defineAgent({
  descriptor: { id: "t.upper", name: "Upper", version: "1.0.0", capabilities: [{ id: "up", description: "uppercase" }] },
  async handle(goal, ctx) {
    ctx.progress(50, "working");
    return [{ kind: "text", text: textOf(goal).toUpperCase() }];
  },
});

const exclaim = defineAgent({
  descriptor: { id: "t.exclaim", name: "Exclaim", version: "1.0.0", capabilities: [{ id: "ex", description: "add !" }] },
  async handle(goal) {
    return [{ kind: "text", text: textOf(goal) + "!" }];
  },
});

const boom = defineAgent({
  descriptor: { id: "t.boom", name: "Boom", version: "1.0.0", capabilities: [{ id: "b", description: "fail" }] },
  async handle() {
    throw new Error("kaboom");
  },
});

test("coordinator chains members: output → input", async () => {
  const team = new Coordinator([
    { name: "upper", client: inProcess(upper) },
    { name: "exclaim", client: inProcess(exclaim) },
  ]);
  const a = await team.call("upper", [{ kind: "text", text: "hello" }]);
  const b = await team.call("exclaim", a.parts);
  assert.equal(textOf(b.parts).trim(), "HELLO!");
  await team.close();
});

test("coordinator forwards member progress to a sink, tagged with the name", async () => {
  const notes: string[] = [];
  const sink: EventSink = { progress: (_p, msg) => notes.push(msg ?? "") };
  const team = new Coordinator([{ name: "upper", client: inProcess(upper) }]);
  await team.call("upper", [{ kind: "text", text: "hi" }], { sink });
  assert.ok(notes.some((n) => n.startsWith("upper:")), "progress tagged with member name");
  assert.ok(notes.some((n) => n.includes("upper → completed")), "status forwarded as progress");
  await team.close();
});

test("a failing member surfaces as a thrown AgentError", async () => {
  const team = new Coordinator([{ name: "boom", client: inProcess(boom) }]);
  await assert.rejects(
    () => team.call("boom", [{ kind: "text", text: "x" }]),
    (err: any) => /Member "boom" ended failed/.test(err.message),
  );
  await team.close();
});

test("callMany fans out in parallel", async () => {
  const team = new Coordinator([
    { name: "upper", client: inProcess(upper) },
    { name: "exclaim", client: inProcess(exclaim) },
  ]);
  const [u, e] = await team.callMany([
    { name: "upper", goal: [{ kind: "text", text: "a" }] },
    { name: "exclaim", goal: [{ kind: "text", text: "b" }] },
  ]);
  assert.equal(textOf(u.parts).trim(), "A");
  assert.equal(textOf(e.parts).trim(), "b!");
  await team.close();
});
