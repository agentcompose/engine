// Runs a deterministic workflow through the Engine: researcher → summarizer,
// wired by variable references, over registered agents. Demonstrates the goal →
// plan → governed, checkpointed execution stream.
//   node examples/run-engine.ts "your topic"
import { inProcess } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";
import { Engine, AgentRegistry, authoredPlan } from "../src/index.ts";
import { researcher, summarizer } from "./agents.ts";

const topic = process.argv.slice(2).join(" ") || "AI agent interoperability standards";
const log = (s: string) => process.stderr.write(s + "\n");
const partText = (p: Part) => (p.kind === "text" ? p.text : JSON.stringify(p));

const registry = new AgentRegistry({
  researcher: inProcess(researcher),
  summarizer: inProcess(summarizer),
});

// The authored plan: a two-step DAG. summarize.input references research's output.
const planner = authoredPlan([
  { id: "research", agent: "researcher", input: [{ from: "goal" }], config: { depth: "deep" } },
  { id: "summary", agent: "summarizer", input: [{ from: "step", ref: "research" }], config: { maxBullets: 3 } },
]);

const engine = new Engine({ registry, planner });

log(`▶ goal: ${topic}\n`);
let runId = "";
for await (const ev of engine.run([{ kind: "text", text: topic }])) {
  if (ev.type === "plan") log(`  plan: ${ev.steps.map((s) => `${s.id}(${s.agent})`).join(" → ")}`);
  else if (ev.type === "step-started") log(`  ▷ ${ev.stepId} started`);
  else if (ev.type === "progress") log(`    · ${ev.percent != null ? ev.percent + "%" : "  "} ${ev.message ?? ""}`);
  else if (ev.type === "message") process.stdout.write(ev.delta.kind === "text" ? ev.delta.text : "");
  else if (ev.type === "step-completed") log(`  ✓ ${ev.stepId} completed`);
  else if (ev.type === "result") log(`\n▶ result:\n${ev.parts.map(partText).join("")}`);
  else if (ev.type === "error") log(`\n✗ error: ${ev.error.message}`);
}

await registry.close();
