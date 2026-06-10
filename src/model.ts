// The planner's model seam — the "decide" port.
//
// A dynamic planner needs to ask a model "given the goal, what we've learned, and
// the agents available, what's the next action?" That question is provider-neutral.
// The engine core defines only this port; an adapter (separate, opt-in) implements
// it over a real model. Core takes ZERO model dependencies.
//
// Why a port and not a library: the connection layer (talk to a model) and the
// structured-output layer (get a schema-valid answer) each have mature, purpose-built
// solvers — gateways, provider-native structured output, Instructor, Pi's pi-ai, the
// Vercel AI SDK. We don't pick one for you; we define the seam they plug into.
import type { Part } from "@agentcompose/sdk";

/** An agent the decider may choose to invoke (a registry entry, described for choice). */
export interface AgentChoice {
  /** The registry key the planner will use to run it. */
  name: string;
  /** Human-facing title (from the agent descriptor). */
  title: string;
  /** What it does — its capabilities — so the model can choose well. */
  description: string;
}

/** A prior step's distilled output, shown to the decider as an observation. */
export interface Observation {
  stepId: string;
  text: string;
}

/** Everything the decider needs to choose the next action. Fully provider-neutral. */
export interface DecisionRequest {
  goal: string;
  observations: Observation[];
  choices: AgentChoice[];
}

/**
 * What the decider returns. The planner maps it to a Plan:
 *   call   → run `agent` with `instruction` plus any referenced inputs (`use`)
 *   finish → end the run; result is `use`'d outputs, or literal `text`
 * `use` entries are "goal" or a prior step id — the same variable-reference model
 * the executor already uses, now exposed to the planner.
 */
export type Action =
  | { kind: "call"; agent: string; instruction?: string; use?: string[] }
  | { kind: "finish"; use?: string[]; text?: string };

/** THE PORT. Engine core depends only on this. Adapters implement it over a model. */
export interface Decider {
  decide(req: DecisionRequest): Promise<Action>;
}

/**
 * Reference/test decider: a scripted policy with no model and no network. Pass an
 * array of actions (consumed in order) or a function of the request. The function
 * form is a pure function of the request — which keeps a dynamic run *re-derivable*
 * on resume (the observations are restored, so the same input yields the same action).
 */
export type Decision = Action | ((req: DecisionRequest) => Action | Promise<Action>);

export class ScriptedDecider implements Decider {
  #script: Decision[] | ((req: DecisionRequest) => Action | Promise<Action>);
  #i = 0;

  constructor(script: Decision[] | ((req: DecisionRequest) => Action | Promise<Action>)) {
    this.#script = script;
  }

  async decide(req: DecisionRequest): Promise<Action> {
    if (typeof this.#script === "function") return this.#script(req);
    const next = this.#script[this.#i++] ?? this.#script.at(-1);
    if (!next) throw new Error("ScriptedDecider: no decisions left in the script.");
    return typeof next === "function" ? next(req) : next;
  }
}

/** Render Part[] to plain text for prompts/observations. Text and data parts are
 *  rendered inline; a file part becomes a `[file: ...]` placeholder so the decider at
 *  least knows an artifact was produced (its bytes are out of band for a text decider). */
export function partsToText(parts: Part[]): string {
  return parts
    .map((p) =>
      p.kind === "text"
        ? p.text
        : p.kind === "data"
          ? JSON.stringify(p.data)
          : p.kind === "file"
            ? `[file: ${p.name ?? p.mimeType ?? p.uri}]`
            : "",
    )
    .filter(Boolean)
    .join("\n");
}
