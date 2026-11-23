// SPDX-License-Identifier: LicenseRef-Proprietary
/** Server request handler timeout (30 s); requests longer than this emit a 503 with Retry-After. */
export const SERVER_REQUEST_TIMEOUT_MS = 30_000;
/** Extra client transport slack so the browser receives the server's 503 + Retry-After before aborting. */
export const TRANSPORT_SLACK_MS = 15_000;
/** Allow the server's 30 s REQUEST_TIMEOUT plus transport time to deliver its 503 and Retry-After. */
export const DEFAULT_REQUEST_TIMEOUT_MS = SERVER_REQUEST_TIMEOUT_MS + TRANSPORT_SLACK_MS;
/** Uploads and downloads need transfer time; API uploads still obey the server's handler budget. */
export const LONG_REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * Return `true` when an error was produced by [`requestDeadline`] timing out.
 * Such errors already exceeded the 30 s server budget + transport slack and
 * must not be retried by React Query.
 */
export function isDeadlineTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur instanceof Error; depth += 1) {
    if (cur.name === "TimeoutError") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** One network attempt, including its response body; never include session recovery or a passkey prompt. */
export function requestDeadline(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, caller?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  const network = new AbortController();
  deadline.addEventListener("abort", () => network.abort(new TypeError("Failed to fetch", { cause: deadline.reason })), { once: true });
  return AbortSignal.any(caller ? [caller, network.signal] : [network.signal]);
}
