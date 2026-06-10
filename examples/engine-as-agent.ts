// Recursive composition: an Engine wrapped as an agent, used as a STEP inside another
// engine. The inner engine researches + summarizes; the outer engine treats that whole
// pipeline as a single worker, then formats the result. "A master agent IS an agent."
//   node examples/engine-as-agent.ts "your topic"
import { inProcess } from "@agentcompose/sdk";
import { Engine, AgentRegistry, authoredPlan, asAgent } from "../src/index.ts";
import { researcher, summarizer, formatter } from "./agents.ts";

const topic = process.argv.slice(2).join(" ") || "AI agent interoperability standards";
const log = (s: string) => process.stderr.write(s + "\n");

// Inner engine: research → summarize.
const innerEngine = new Engine({
  registry: new AgentRegistry({ researcher: inProcess(researcher), summarizer: inProcess(summarizer) }),
  planner: authoredPlan([
    { id: "research", agent: "researcher", input: [{ from: "goal" }], config: { depth: "deep" } },
    { id: "summary", agent: "summarizer", input: [{ from: "step", ref: "research" }], config: { maxBullets: 3 } },
  ]),
});

// Wrap it as an agent, and register it as one worker in an outer engine.
const innerAsAgent = inProcess(
  asAgent({
    descriptor: { id: "x.research-pipeline", name: "Research Pipeline", version: "1.0.0", capabilities: [{ id: "rp", description: "research and summarize a topic" }] },
    engine: innerEngine,
  }),
);

const outer = new Engine({
  registry: new AgentRegistry({ pipeline: innerAsAgent, formatter: inProcess(formatter) }),
  planner: authoredPlan([
    { id: "deep", agent: "pipeline", input: [{ from: "goal" }] },
    { id: "final", agent: "formatter", input: [{ from: "step", ref: "deep" }] },
  ]),
});

log(`▶ goal: ${topic}\n`);
for await (const ev of outer.run([{ kind: "text", text: topic }])) {
  if (ev.type === "step-started") log(`  ▷ ${ev.stepId} (${ev.agent})`);
  else if (ev.type === "progress" && ev.message) log(`      · ${ev.message}`);
  else if (ev.type === "step-completed") log(`  ✓ ${ev.stepId}`);
  else if (ev.type === "result") log(`\n▶ result:\n${ev.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")}`);
  else if (ev.type === "error") log(`\n✗ ${ev.error.message}`);
}
