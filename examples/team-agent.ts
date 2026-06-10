// A master "team" agent: it coordinates a researcher and a summarizer, and is
// ITSELF an AgentCompose agent (recursive composition). The flow here is
// hand-written — that is deterministic composition via the Coordinator. The
// Engine (next) will *generate* this flow from a goal instead.
import { defineAgent, inProcess, serveStdio } from "@agentcompose/sdk";
import { Coordinator } from "../src/index.ts";
import { researcher, summarizer } from "./agents.ts";

const team = new Coordinator([
  { name: "researcher", client: inProcess(researcher), config: { depth: "deep" } },
  { name: "summarizer", client: inProcess(summarizer), config: { maxBullets: 3 } },
]);

export const teamAgent = defineAgent({
  descriptor: {
    id: "dev.agentcompose.examples.research-team",
    name: "Research Team",
    version: "1.0.0",
    description: "Researches a topic, then summarizes the findings.",
    capabilities: [
      { id: "research-and-summarize", description: "Research a topic and return a bulleted summary.", inputModes: ["text/plain"], outputModes: ["text/markdown"] },
    ],
  },
  async handle(goal, ctx) {
    ctx.progress(5, "delegating to researcher");
    const research = await team.call("researcher", goal, { sink: ctx, signal: ctx.signal });
    if (ctx.signal.aborted) return;

    ctx.progress(60, "delegating to summarizer");
    const summary = await team.call("summarizer", research.parts, { sink: ctx, signal: ctx.signal, forwardMessages: true });

    ctx.artifact([{ kind: "data", data: { team: team.names() }, mimeType: "application/json" }], "trace.json");
    return summary.parts;
  },
});

if (import.meta.url === `file://${process.argv[1]}`) {
  serveStdio(teamAgent);
  process.stderr.write("team-agent: serving over stdio\n");
}
