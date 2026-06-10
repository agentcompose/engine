// Resolve a step's input bindings into concrete Part[] from the goal and prior
// step outputs. Concatenates bindings left-to-right.
import { AgentError, JsonRpcCodes } from "@agentcompose/sdk";
import type { Part } from "@agentcompose/sdk";
import type { Binding } from "./types.ts";
import type { RunContext } from "./context.ts";

export function resolveBindings(bindings: Binding[], ctx: RunContext): Part[] {
  const parts: Part[] = [];
  for (const b of bindings) {
    if (b.from === "goal") {
      parts.push(...ctx.goal);
    } else if (b.from === "const") {
      parts.push(...b.parts);
    } else {
      if (!ctx.has(b.ref)) {
        throw new AgentError(
          JsonRpcCodes.InvalidParams,
          `Binding references step "${b.ref}" which has no output yet (bad dependency order?).`,
        );
      }
      parts.push(...ctx.get(b.ref));
    }
  }
  return parts;
}

/** Step ids this binding list depends on (for dependency ordering / cycle checks). */
export function dependencies(bindings: Binding[]): string[] {
  return bindings.filter((b): b is { from: "step"; ref: string } => b.from === "step").map((b) => b.ref);
}
