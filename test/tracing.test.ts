import { test } from "node:test";
import assert from "node:assert/strict";
import { defineAgent, inProcess } from "@agentcompose/sdk";
import type { Part, Span } from "@agentcompose/sdk";
import { Engine, AgentRegistry, authoredPlan, asAgent } from "../src/index.ts";

const textOf = (parts: Part[]) => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ").trim();
const goal = (t: string): Part[] => [{ kind: "text", text: t }];

// A worker that opens a domain span of its own, so we can prove leaf-agent spans nest
// under the engine's step span (and survive an asAgent boundary).
const worker = (id: string, name: string, fn: (s: string) => string) =>
  defineAgent({
    descriptor: { id, name, version: "1.0.0", capabilities: [{ id: "c", description: name }] },
    async handle(g, ctx) {
      return ctx.trace.span({ name: "work", kind: "internal", attributes: { worker: name } }, async () => {
        return [{ kind: "text", text: fn(textOf(g)) }];
      });
    },
  });

const upper = worker("t.upper", "Upper", (s) => s.toUpperCase());
const exclaim = worker("t.exclaim", "Exclaim", (s) => s + "!");

/** Materialize spans from an engine EngineEvent stream's span-start/span-end events. */
function spansOf(events: { type: string; [k: string]: unknown }[]): Span[] {
  const byId = new Map<string, Span>();
  for (const e of events) {
    if (e.type === "span-start") {
      const s = e.span as Span;
      byId.set(s.spanId, { ...s, status: "unset" });
    } else if (e.type === "span-end") {
      const s = byId.get(e.spanId as string);
      if (s) {
        s.endTime = e.endTime as number;
        s.status = e.status as Span["status"];
      }
    }
  }
  return [...byId.values()];
}

function childrenOf(spans: Span[], parentId: string | undefined): Span[] {
  return spans.filter((s) => s.parentSpanId === parentId);
}

test("tracing: a run produces a nested trace — run → step → leaf-agent spans", async () => {
  const reg = new AgentRegistry({ upper: inProcess(upper), exclaim: inProcess(exclaim) });
  const engine = new Engine({
    registry: reg,
    planner: authoredPlan([
      { id: "a", agent: "upper", input: [{ from: "goal" }] },
      { id: "b", agent: "exclaim", input: [{ from: "step", ref: "a" }] },
    ]),
  });

  const events: { type: string; [k: string]: unknown }[] = [];
  for await (const ev of engine.run(goal("hello"), { runId: "trace-1" })) events.push(ev as never);
  const spans = spansOf(events);

  // Single trace id across everything.
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);

  // One run root.
  const root = spans.find((s) => s.kind === "run" && s.parentSpanId === undefined)!;
  assert.ok(root, "a parentless run span exists");
  assert.equal(root.status, "ok");

  // Two step spans under the root.
  const steps = childrenOf(spans, root.spanId).filter((s) => s.kind === "step");
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map((s) => s.name).sort(), ["a", "b"]);

  // Each step has the worker's own root agent span nested beneath it (re-stamped on
  // ingest), which in turn contains the worker's "work" span.
  for (const step of steps) {
    const agentSpan = childrenOf(spans, step.spanId).find((s) => s.kind === "agent");
    assert.ok(agentSpan, `step ${step.name} carries the delegated agent's root span`);
    const work = childrenOf(spans, agentSpan!.spanId).find((s) => s.name === "work");
    assert.ok(work, `agent span under step ${step.name} contains its domain span`);
  }
  await reg.close();
});

test("tracing: asAgent forwards the inner trace losslessly (no flattening)", async () => {
  // An inner engine wrapped as an agent, used as a step in an outer engine. The inner
  // run's whole trace must reappear under the outer step span — the property that
  // motivated a span contract over flattening to progress text.
  const innerReg = new AgentRegistry({ upper: inProcess(upper), exclaim: inProcess(exclaim) });
  const innerEngine = new Engine({
    registry: innerReg,
    planner: authoredPlan([
      { id: "a", agent: "upper", input: [{ from: "goal" }] },
      { id: "b", agent: "exclaim", input: [{ from: "step", ref: "a" }] },
    ]),
  });
  const inner = inProcess(
    asAgent({
      descriptor: { id: "x.inner", name: "Inner", version: "1.0.0", capabilities: [{ id: "c", description: "team" }] },
      engine: innerEngine,
    }),
  );

  const outerReg = new AgentRegistry({ inner });
  const outer = new Engine({
    registry: outerReg,
    planner: authoredPlan([{ id: "deep", agent: "inner", input: [{ from: "goal" }] }]),
  });

  const events: { type: string; [k: string]: unknown }[] = [];
  for await (const ev of outer.run(goal("hi"), { runId: "trace-rec" })) events.push(ev as never);
  const spans = spansOf(events);

  // The entire composed tree shares ONE trace id, despite spanning multiple engines/tasks.
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1, "one trace across the composition");

  const outerRoot = spans.find((s) => s.kind === "run" && s.parentSpanId === undefined)!;
  const deepStep = childrenOf(spans, outerRoot.spanId).find((s) => s.name === "deep")!;
  assert.ok(deepStep, "outer step exists");

  // Under the outer "deep" step: the wrapper agent's root span, then the INNER run span,
  // then the inner step spans — the full sub-trace, not a flattened blob.
  const wrapperAgent = childrenOf(spans, deepStep.spanId).find((s) => s.kind === "agent")!;
  assert.ok(wrapperAgent, "asAgent wrapper root span nests under the outer step");
  const innerRun = childrenOf(spans, wrapperAgent.spanId).find((s) => s.kind === "run")!;
  assert.ok(innerRun, "inner engine run span is preserved under the wrapper");
  const innerSteps = childrenOf(spans, innerRun.spanId).filter((s) => s.kind === "step");
  assert.deepEqual(innerSteps.map((s) => s.name).sort(), ["a", "b"], "inner step spans preserved");

  await outerReg.close();
});
