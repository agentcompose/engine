// The set of agents a run may use, keyed by the name steps reference. Holds the
// client and (lazily) the descriptor. The engine never constructs clients; the
// product builds the registry and injects it.
import { AgentError, JsonRpcCodes } from "@agentcompose/sdk";
import type { AgentClient, AgentDescriptor } from "@agentcompose/sdk";

export interface RegistryEntry {
  client: AgentClient;
  /** Optional cached descriptor; fetched on demand if absent. */
  descriptor?: AgentDescriptor;
}

export class AgentRegistry {
  #entries = new Map<string, RegistryEntry>();

  constructor(entries: Record<string, AgentClient | RegistryEntry> = {}) {
    for (const [name, value] of Object.entries(entries)) {
      this.set(name, value);
    }
  }

  set(name: string, value: AgentClient | RegistryEntry): this {
    const entry: RegistryEntry = "client" in value ? value : { client: value };
    this.#entries.set(name, entry);
    return this;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  names(): string[] {
    return [...this.#entries.keys()];
  }

  /** Resolve a client by name, or throw InvalidParams if it is not registered. */
  client(name: string): AgentClient {
    const entry = this.#entries.get(name);
    if (!entry) {
      throw new AgentError(
        JsonRpcCodes.InvalidParams,
        `No agent registered as "${name}". Registered: ${this.names().join(", ") || "(none)"}.`,
      );
    }
    return entry.client;
  }

  /** Fetch (and cache) a descriptor — used by planners to choose agents. */
  async describe(name: string): Promise<AgentDescriptor> {
    const entry = this.#entries.get(name);
    if (!entry) throw new AgentError(JsonRpcCodes.InvalidParams, `No agent registered as "${name}".`);
    entry.descriptor ??= await entry.client.describe();
    return entry.descriptor;
  }

  /** Close every registered client (terminates spawned subprocesses). */
  async close(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((e) => e.client.close()));
  }
}
