// Reference Decider adapter — the ONLY place a model is actually contacted.
//
// It targets the broadest substrate: an OpenAI-compatible /chat/completions endpoint.
// Point `baseUrl` at OpenAI, or at a gateway (LiteLLM, OpenRouter, Portkey, Cloudflare,
// the Vercel AI gateway) to reach any provider — which is exactly what the spec's
// `Provider { baseUrl, apiKey }` already assumes. Provider portability is therefore an
// ops choice (the gateway), not a code dependency: this adapter has NO npm deps, just
// global fetch.
//
// This is deliberately one swappable implementation. To use Pi's connection layer
// (@earendil-works/pi-ai), the Vercel AI SDK, Instructor, or provider-native structured
// outputs instead, write another `Decider` against the same port — the engine core and
// the dynamic planner do not change.
//
// Import path: `@agentcompose/engine/adapters/openai`.
import { AgentError, JsonRpcCodes } from "@agentcompose/sdk";
import type { Decider, DecisionRequest, Action } from "../model.ts";

export interface OpenAICompatibleOptions {
  /** e.g. "https://api.openai.com/v1" or a gateway base URL. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra system guidance prepended to the engine's own instructions. */
  system?: string;
  temperature?: number;
  /** Injectable fetch, for testing without a network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["call", "finish"] },
    agent: { type: "string", description: "agent name to call (kind=call)" },
    instruction: { type: "string", description: "what the agent should do (kind=call)" },
    use: {
      type: "array",
      items: { type: "string" },
      description: '"goal" or a prior step id whose output to feed in',
    },
    text: { type: "string", description: "final answer when not using step outputs (kind=finish)" },
  },
} as const;

function buildMessages(req: DecisionRequest, system?: string): { role: string; content: string }[] {
  const agents = req.choices.map((c) => `  - ${c.name}: ${c.title}${c.description ? ` — ${c.description}` : ""}`).join("\n");
  const obs = req.observations.length
    ? req.observations.map((o) => `  - ${o.stepId}: ${o.text}`).join("\n")
    : "  (none yet)";

  const sys =
    (system ? system + "\n\n" : "") +
    [
      "You orchestrate agents to accomplish a goal. Each turn, choose ONE next action.",
      'Call an agent: {"kind":"call","agent":"<name>","instruction":"<what to do>","use":["goal" or a step id, ...]}.',
      'Finish: {"kind":"finish","use":["<step id>", ...]} to return prior outputs, or {"kind":"finish","text":"<answer>"}.',
      'Use "use" to feed the goal or prior step outputs into the agent or the final result.',
      "Finish as soon as the goal is satisfied. Respond with a single JSON object, no prose.",
    ].join("\n");

  const user = [`GOAL:\n${req.goal}`, `AVAILABLE AGENTS:\n${agents}`, `OBSERVATIONS SO FAR:\n${obs}`].join("\n\n");
  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate and normalize a parsed object into an Action (drops unknown keys). */
function validateAction(obj: any): Action {
  if (!obj || typeof obj !== "object") {
    throw new AgentError(JsonRpcCodes.InternalError, "Decider model did not return a JSON object.");
  }
  if (obj.kind === "call") {
    if (typeof obj.agent !== "string" || !obj.agent) {
      throw new AgentError(JsonRpcCodes.InternalError, 'Decider "call" action is missing a string "agent".');
    }
    if (obj.instruction !== undefined && typeof obj.instruction !== "string") {
      throw new AgentError(JsonRpcCodes.InternalError, 'Decider "call".instruction must be a string.');
    }
    if (obj.use !== undefined && !isStringArray(obj.use)) {
      throw new AgentError(JsonRpcCodes.InternalError, 'Decider "call".use must be an array of strings.');
    }
    return { kind: "call", agent: obj.agent, instruction: obj.instruction, use: obj.use };
  }
  if (obj.kind === "finish") {
    if (obj.use !== undefined && !isStringArray(obj.use)) {
      throw new AgentError(JsonRpcCodes.InternalError, 'Decider "finish".use must be an array of strings.');
    }
    if (obj.text !== undefined && typeof obj.text !== "string") {
      throw new AgentError(JsonRpcCodes.InternalError, 'Decider "finish".text must be a string.');
    }
    return { kind: "finish", use: obj.use, text: obj.text };
  }
  throw new AgentError(JsonRpcCodes.InternalError, `Decider model returned unknown kind "${obj.kind}".`);
}

function parseAction(content: string): Action {
  const trimmed = content.trim();
  let obj: unknown;
  try {
    // Happy path: strict/structured output yields a pure JSON object.
    obj = JSON.parse(trimmed);
  } catch {
    // Fallback for gateways that wrap JSON in prose: extract the outermost braces.
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new AgentError(JsonRpcCodes.InternalError, "Decider model returned no JSON object.");
    try {
      obj = JSON.parse(match[0]);
    } catch {
      throw new AgentError(JsonRpcCodes.InternalError, "Decider model returned invalid JSON.");
    }
  }
  return validateAction(obj);
}

/**
 * Build a Decider over an OpenAI-compatible chat endpoint. Requests JSON-schema-shaped
 * structured output (with a JSON-object fallback for gateways that don't honor schema),
 * so the model — not hand-rolled prompt-scraping — produces the action.
 */
export function openAICompatibleDecider(opts: OpenAICompatibleOptions): Decider {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async decide(req: DecisionRequest): Promise<Action> {
      const res = await doFetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          temperature: opts.temperature ?? 0,
          messages: buildMessages(req, opts.system),
          response_format: {
            type: "json_schema",
            json_schema: { name: "engine_action", schema: ACTION_SCHEMA, strict: false },
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AgentError(JsonRpcCodes.InternalError, `Decider model HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new AgentError(JsonRpcCodes.InternalError, "Decider model returned an empty response.");
      return parseAction(content);
    },
  };
}
