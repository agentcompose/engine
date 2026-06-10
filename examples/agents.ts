// Two small, deterministic member agents for the composition demo. In a real
// system these would be adapters over existing tools (see the spec's authoring
// guide); kept trivial here so the demo focuses on coordination.
import { defineAgent } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";

const textOf = (parts: Part[]) => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ").trim();

export const researcher = defineAgent({
  descriptor: {
    id: "dev.agentcompose.examples.researcher",
    name: "Researcher",
    version: "1.0.0",
    capabilities: [{ id: "research", description: "Summarize a topic.", inputModes: ["text/plain"], outputModes: ["text/markdown"] }],
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: { depth: { type: "string", enum: ["shallow", "deep"], default: "shallow" } },
    },
  },
  async handle(goal, ctx) {
    const topic = textOf(goal);
    const deep = ctx.config.depth === "deep";
    ctx.progress(40, "researching");
    const text = deep
      ? `A deep review of "${topic}": the leading agent-interop standards are MCP (tools), A2A (agent-to-agent), and AgentCompose (composable components). Each operates at a different layer. Adoption is consolidating under the Linux Foundation.`
      : `A quick take on "${topic}": MCP, A2A, and AgentCompose.`;
    ctx.progress(100, "done");
    return [{ kind: "text", text }];
  },
});

export const summarizer = defineAgent({
  descriptor: {
    id: "dev.agentcompose.examples.summarizer",
    name: "Summarizer",
    version: "1.0.0",
    capabilities: [{ id: "summarize", description: "Summarize text into bullets.", inputModes: ["text/plain"], outputModes: ["text/markdown"] }],
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: { maxBullets: { type: "integer", minimum: 1, maximum: 10, default: 3 } },
    },
  },
  async handle(goal, ctx) {
    const text = textOf(goal);
    const maxBullets = (ctx.config.maxBullets as number) ?? 3;
    ctx.progress(20, "splitting");
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const bullets = (sentences.length ? sentences : [text]).slice(0, maxBullets).map((s) => `• ${s}`);
    let out = "Summary:\n";
    for (const b of bullets) {
      out += b + "\n";
      ctx.message({ kind: "text", text: b + "\n" });
    }
    ctx.progress(100, "done");
    return [{ kind: "text", text: out.trimEnd() }];
  },
});

export const formatter = defineAgent({
  descriptor: {
    id: "dev.agentcompose.examples.formatter",
    name: "Formatter",
    version: "1.0.0",
    capabilities: [{ id: "format", description: "Wrap text in a titled block.", inputModes: ["text/plain"], outputModes: ["text/markdown"] }],
  },
  async handle(goal) {
    return [{ kind: "text", text: `=== RESULT ===\n${textOf(goal)}\n==============` }];
  },
});
