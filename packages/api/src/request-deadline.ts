// SPDX-License-Identifier: LicenseRef-Proprietary
/** Allow the server's 30 s REQUEST_TIMEOUT plus transport time to deliver its 503 and Retry-After. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
/** Uploads and downloads need transfer time; API uploads still obey the server's handler budget. */
export const LONG_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** One network attempt, including its response body; never include session recovery or a passkey prompt. */
export function requestDeadline(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, caller?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  const network = new AbortController();
  deadline.addEventListener("abort", () => network.abort(new TypeError("Failed to fetch", { cause: deadline.reason })), { once: true });
  return AbortSignal.any(caller ? [caller, network.signal] : [network.signal]);
}
