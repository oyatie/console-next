import { ApiError } from "@console/api";

/**
 * A refusal (4xx: not signed in, no permission, not found, refused by a rule) is the server's answer, not a fault:
 * it is shown once and never asked again on its own. Only a person's retry (refetch) asks again.
 */
const isAnswer = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500;

/**
 * The app's query defaults for refusals and faults. A fault (5xx, network) is retried twice, after the server's
 * Retry-After when it sent one; a 429 with Retry-After is retried the same way, and a Retry-After longer than
 * MAX_RETRY_AFTER_MS is not waited out (the error says when to come back). An exhausted read stays failed on mount:
 * the shell's pending gate and a child reading the same key must not restart each other's retry budgets.
 * Nothing re-reads on a timer, on focus or on reconnect (decision #27): the event stream (lib/live) invalidates.
 */
/** The longest Retry-After a read waits on its own; past it the error shows when to come back (TS-28). */
export const MAX_RETRY_AFTER_MS = 30_000;
/** A 429 or 503 that says when to come back: retried no sooner (RFC 9110 §10.2.3). */
const comeBack = (e: unknown) => e instanceof ApiError && (e.status === 429 || e.status === 503) && e.retryAfterMs !== undefined;
const retryable = (e: unknown) =>
  comeBack(e) ? (e as ApiError).retryAfterMs! <= MAX_RETRY_AFTER_MS : !isAnswer(e);

export const queryDefaults = {
  retry: (n: number, e: unknown) => retryable(e) && n < 2,
  retryDelay: (n: number, e: unknown) => Math.max(e instanceof ApiError ? e.retryAfterMs ?? 0 : 0, Math.min(1000 * 2 ** n * (1 + Math.random()), MAX_RETRY_AFTER_MS)),
  retryOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};
