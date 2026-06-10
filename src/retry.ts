// Step resilience: error classification, bounded retry with backoff, and fallback.
//
// Design notes:
//   - Per-step knobs (RetryConfig) are JSON-only so a Step stays serializable and
//     durable suspend/resume keeps working. The classifier (a function) is engine-wide,
//     not per-step, for the same reason.
//   - Only *transient* failures retry. Validation / auth / capability errors fail fast —
//     retrying them just wastes attempts. Override `retryable` to change the policy.
//   - Retries happen in-process within a single step execution; they are not individually
//     checkpointed. On crash mid-retry, resume re-runs the step from attempt 1 (steps are
//     idempotent re-derivable by design). Exactly-once across crashes needs idempotency
//     keys — see DESIGN.md (deferred).
import type { RpcError } from "@agentcompose/sdk";
import { ErrorCodes } from "@agentcompose/sdk";

/** JSON-serializable per-step / engine-default retry knobs. */
export interface RetryConfig {
  /** Total attempts per agent, including the first. 1 disables retry. Default 3. */
  maxAttempts?: number;
  /** First backoff delay in ms. Default 250. */
  initialMs?: number;
  /** Backoff growth factor. Default 2 (exponential). */
  factor?: number;
  /** Upper bound on a single backoff delay in ms. Default 10_000. */
  maxMs?: number;
  /** Apply full jitter (random in [0, computed]). Default true. */
  jitter?: boolean;
  /** Per-attempt timeout in ms. A timed-out attempt is cancelled and retried. */
  timeoutMs?: number;
}

/** Decides whether a failed attempt is worth retrying. */
export type Retryable = (error: RpcError, attempt: number) => boolean;

/** A fully-resolved policy (knobs filled, classifier bound). */
export interface ResolvedRetry {
  maxAttempts: number;
  initialMs: number;
  factor: number;
  maxMs: number;
  jitter: boolean;
  timeoutMs?: number;
  retryable: Retryable;
}

export const DEFAULT_RETRY: Required<Omit<RetryConfig, "timeoutMs">> = {
  maxAttempts: 3,
  initialMs: 250,
  factor: 2,
  maxMs: 10_000,
  jitter: true,
};

// Transient signatures commonly surfaced in error messages by HTTP/network adapters.
const TRANSIENT_MESSAGE =
  /\b(HTTP (?:408|429|5\d\d)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network|fetch failed|timed out|timeout|temporarily unavailable|overloaded)\b/i;

/**
 * Default classifier: retry rate-limits and transient network/server failures; do not
 * retry validation, auth, capability, or other deterministic errors.
 */
export function defaultRetryable(error: RpcError): boolean {
  if (error.code === ErrorCodes.RateLimited) return true;
  return typeof error.message === "string" && TRANSIENT_MESSAGE.test(error.message);
}

/** Merge engine-default knobs with a step override and bind the classifier. */
export function resolveRetry(
  base: RetryConfig | undefined,
  step: RetryConfig | undefined,
  retryable: Retryable,
): ResolvedRetry {
  const merged = { ...DEFAULT_RETRY, ...base, ...step };
  const timeoutMs = step?.timeoutMs ?? base?.timeoutMs;
  return {
    maxAttempts: Math.max(1, Math.floor(merged.maxAttempts)),
    initialMs: Math.max(0, merged.initialMs),
    factor: Math.max(1, merged.factor),
    maxMs: Math.max(0, merged.maxMs),
    jitter: merged.jitter,
    timeoutMs: timeoutMs !== undefined ? Math.max(0, timeoutMs) : undefined,
    retryable,
  };
}

/** Backoff delay (ms) before retrying `attempt` (1-based: attempt 1 just failed). */
export function computeBackoff(r: ResolvedRetry, attempt: number): number {
  const exp = r.initialMs * Math.pow(r.factor, Math.max(0, attempt - 1));
  const capped = Math.min(r.maxMs, exp);
  const delay = r.jitter ? Math.random() * capped : capped;
  return Math.round(delay);
}
