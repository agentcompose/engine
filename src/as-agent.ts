// asAgent — expose an Engine as an AgentComponent.
//
// This closes the recursion the whole model rests on: an engine *is* an agent, so an
// engine can be a step inside another engine. The wrapper is thin — it drives
// engine.run() and translates the engine's event stream onto the agent handler's
// emit surface, mapping the final result out and errors up.
//
// Approval bridges to the agent's own input-required state: when the engine's governor
// asks for approval, the wrapped agent pauses via ctx.requestInput and resumes when the
// caller provides input ("no"/"deny"/"reject"/"cancel" denies; anything else approves).
//
// Deferred (clearly): durable resume *across* the agent boundary — this wrapper drives a
// run to completion in one handler invocation (approval via the in-memory requestInput
// path), rather than checkpoint-suspending the outer task. ctx.config is not yet mapped
// onto engine/planner parameters.
import { AgentError, JsonRpcCodes, defineAgent } from "@agentcompose/sdk";
import type { AgentDescriptor, AgentDefinition, HandlerContext, Part } from "@agentcompose/sdk";
import type { Engine, OnApproval } from "./engine.ts";

export interface AsAgentOptions {
  /** Identity of the engine-as-agent (id, name, version, capabilities). */
  descriptor: AgentDescriptor;
  /** The engine to drive. Each task starts a fresh run (its own runId). */
  engine: Engine;
}

/** Bridge engine approval requests to the agent's input-required state. */
function approvalViaInput(ctx: HandlerContext): OnApproval {
  const DENY = new Set(["no", "deny", "reject", "cancel"]);
  return async ({ step }) => {
    const prompt: Part[] = [
      { kind: "text", text: `Approve step "${step.id}" (agent: ${step.agent})? Reply "no" to deny.` },
    ];
    const reply = await ctx.requestInput(prompt);
    const text = reply.map((p) => (p.kind === "text" ? p.text : "")).join(" ").trim().toLowerCase();
    return !DENY.has(text);
  };
}

/**
 * Wrap an Engine as an AgentDefinition. Use it like any other agent:
 *   const teamAgent = inProcess(asAgent({ descriptor, engine }));
 *   registry.set("team", teamAgent);   // now an outer engine can call it as a step
 */
export function asAgent(opts: AsAgentOptions): AgentDefinition {
  return defineAgent({
    descriptor: opts.descriptor,
    async handle(goal, ctx) {
      let result: Part[] | undefined;

      for await (const ev of opts.engine.run(goal, { signal: ctx.signal, onApproval: approvalViaInput(ctx) })) {
        switch (ev.type) {
          case "plan":
            ctx.progress(undefined, `plan: ${ev.steps.map((s) => `${s.id}(${s.agent})`).join(", ")}`);
            break;
          case "step-started":
            ctx.progress(undefined, `▷ ${ev.stepId} (${ev.agent})`);
            break;
          case "progress":
            // Forward inner-step progress, attributing it to the step.
            ctx.progress(ev.percent, ev.message ? `${ev.stepId}: ${ev.message}` : ev.stepId);
            break;
          case "message":
            ctx.message(ev.delta);
            break;
          case "artifact":
            ctx.artifact(ev.artifact.parts, ev.artifact.name);
            break;
          case "step-completed":
            ctx.progress(undefined, `✓ ${ev.stepId}`);
            break;
          case "result":
            result = ev.parts;
            break;
          case "error":
            // Surface the run's failure as the agent's failure, preserving code/message.
            throw new AgentError(ev.error.code, ev.error.message, ev.error.data);
          case "canceled":
            return; // the shared AbortSignal already drives the task to canceled
          // step-failed precedes error; suspended cannot occur (we supply onApproval).
        }
      }

      if (result === undefined) {
        throw new AgentError(JsonRpcCodes.InternalError, "Engine run ended without a result.");
      }
      return result;
    },
  });
}
