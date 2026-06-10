// A GOAL-driven dynamic run: the planner asks a decider what to do next each round,
// instead of following an authored DAG. Runs offline with a ScriptedDecider (a pure
// function of the observations) — no API key, fully deterministic.
//
// To use a real model, swap the decider for the reference adapter:
//
//   import { openAICompatibleDecider } from "../src/adapters/openai-compatible.ts";
//   const decider = openAICompatibleDecider({
//     baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
//     apiKey: process.env.OPENAI_API_KEY!,   // or a gateway key
//     model: process.env.MODEL ?? "gpt-4o-mini",
//   });
//
//   node examples/run-dynamic.ts "your goal"
import { inProcess } from "@agentcompose/sdk";
import { Engine, AgentRegistry, dynamicPlanner, ScriptedDecider } from "../src/index.ts";
import type { Action, DecisionRequest } from "../src/index.ts";
import { researcher, summarizer } from "./agents.ts";

const goal = process.argv.slice(2).join(" ") || "AI agent interoperability standards";
const log = (s: string) => process.stderr.write(s + "\n");

const registry = new AgentRegistry({
  researcher: inProcess(researcher),
  summarizer: inProcess(summarizer),
});

// A scripted "brain": decide from how much we've observed. A real model would reason
// over req.goal / req.observations / req.choices instead — same shape, same seam.
const decider = new ScriptedDecider((req: DecisionRequest): Action => {
  switch (req.observations.length) {
    case 0:
      return { kind: "call", agent: "researcher", use: ["goal"] };
    case 1:
      return { kind: "call", agent: "summarizer", use: ["step-0"] };
    default:
      return { kind: "finish", use: ["step-1"] };
  }
});

const engine = new Engine({ registry, planner: dynamicPlanner({ decider, registry }) });

log(`▶ goal: ${goal}\n`);
for await (const ev of engine.run([{ kind: "text", text: goal }])) {
  if (ev.type === "plan") log(`  → next: ${ev.steps.map((s) => `${s.id}(${s.agent})`).join(", ")}`);
  else if (ev.type === "step-completed") log(`  ✓ ${ev.stepId}`);
  else if (ev.type === "result") log(`\n▶ result:\n${ev.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}`);
  else if (ev.type === "error") log(`\n✗ ${ev.error.message}`);
}

await registry.close();
