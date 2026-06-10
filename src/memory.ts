// Cross-run memory: distilled knowledge carried forward across runs/sessions,
// separate from a single run's working state and durable checkpoints.
//
// Defined as a seam now; the engine's authored-plan executor does not yet consult
// memory (planners and agents are the natural consumers). Wired through RunOptions
// so a dynamic planner can use it without an API change.
export interface MemoryProvider {
  recall(scope: string): Promise<unknown>;
  remember(scope: string, value: unknown): Promise<void>;
}

/** Reference in-memory provider. Replace with a persistent store in production. */
export class InMemoryMemoryProvider implements MemoryProvider {
  #store = new Map<string, unknown>();

  async recall(scope: string): Promise<unknown> {
    return this.#store.get(scope);
  }

  async remember(scope: string, value: unknown): Promise<void> {
    this.#store.set(scope, value);
  }
}
