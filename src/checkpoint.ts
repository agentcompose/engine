// Durable state. A run checkpoints its Snapshot here after each step so it can
// resume — in the same process or a fresh one — from the last completed step
// rather than from the beginning.
//
// The engine depends only on this interface; the product injects a real store
// (database, file, KV). The in-memory store below is the reference implementation
// and the default for tests/local use.
import type { Snapshot } from "./types.ts";

export interface CheckpointStore {
  save(runId: string, snapshot: Snapshot): Promise<void>;
  load(runId: string): Promise<Snapshot | null>;
}

/**
 * Reference store. Serializes through JSON on write to (a) decouple stored state
 * from live object references and (b) fail fast if a snapshot is ever made
 * non-serializable — the same discipline a real persistent store requires.
 *
 * Deferred (clearly): no cross-process durability and no concurrency control. A
 * production store must add a write lock / fencing token per runId so two
 * resumers cannot drive the same run at once.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  #store = new Map<string, string>();

  async save(runId: string, snapshot: Snapshot): Promise<void> {
    this.#store.set(runId, JSON.stringify(snapshot));
  }

  async load(runId: string): Promise<Snapshot | null> {
    const raw = this.#store.get(runId);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  }
}
