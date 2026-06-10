// Drives the master Research Team agent and prints its composed activity.
//   node examples/run-team.ts "your topic"
import { inProcess } from "@agentcompose/sdk";
import { teamAgent } from "./team-agent.ts";
import type { Part } from "@agentcompose/sdk";

const topic = process.argv.slice(2).join(" ") || "AI agent interoperability standards";
const log = (s: string) => process.stderr.write(s + "\n");
const partText = (p: Part) => (p.kind === "text" ? p.text : JSON.stringify(p));

const client = inProcess(teamAgent);
const desc = await client.describe();
log(`▶ ${desc.name} — ${desc.capabilities[0].description}\n`);

const task = await client.submit([{ kind: "text", text: topic }]);
for await (const ev of client.events(task.id)) {
  if (ev.type === "progress") log(`  · ${ev.percent != null ? ev.percent + "%" : "  "} ${ev.message ?? ""}`);
  else if (ev.type === "message") process.stdout.write(ev.delta.kind === "text" ? ev.delta.text : "");
  else if (ev.type === "artifact") log(`\n  · artifact: ${ev.artifact.name}`);
}

const final = await client.get(task.id);
log(`\n▶ ${final.state} · result:\n${final.result?.parts.map(partText).join("")}`);
await client.close();
