import createClient from "openapi-fetch";
// the requested entity reads and commands laid over the generated paths until each is served (see pending/entity.ts).
import type { AllPaths as paths } from "./pending/entity";
import { ApiError, interactionHeaders, languageHeader, noteServerDate, reauthenticated, refresh, session } from "./session";
import { setPlatform, type Platform } from "./platform";

const withBearer = (req: Request) => {
  const r = new Request(req);
  if (session.token) r.headers.set("authorization", `Bearer ${session.token}`);
  for (const [k, v] of Object.entries(interactionHeaders())) r.headers.set(k, v);
  r.headers.set("accept-language", languageHeader());
  return r;
};

// Unauthenticated sign-in calls (and refresh itself): a 401 there is the answer, not an expired token.
const NO_REFRESH = ["/api/v1/auth/token/refresh", "/api/v1/auth/otp/redeem", "/api/v1/auth/passkey/login/"];

/** Match renewal's 30 s budget: a silent connection must reach the screen's network-error/retry state. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Upload/processing and file generation/download need more time, but must still settle on a dead link. */
export const LONG_REQUEST_TIMEOUT_MS = 5 * 60_000;

const longRequest = (method: string, path: string) =>
  (method === "POST" && ["/api/v1/entity-documents", "/api/v1/employees/import/preview"].includes(path)) ||
  (method === "GET" && (["/api/v1/employees/export.csv", "/api/v1/statutory/worker-register/export"].includes(path) || /^\/api\/v1\/entity-documents\/[^/]+\/content$/.test(path)));

/**
 * fetch that attaches the bearer token and the last interaction and, on 401, refreshes once and retries.
 * A refresh that fails for a network error, 429 or 5xx rejects like a network error (the session stays).
 */
export async function authFetch(input: Request): Promise<Response> {
  const principal = session.principal;
  const path = new URL(input.url).pathname;
  const writable = Boolean(session.token || input.headers.get("authorization")) && path.startsWith("/api/v1/") && !["GET", "HEAD", "OPTIONS"].includes(input.method);
  const deadline = AbortSignal.timeout(longRequest(input.method, path) ? LONG_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS);
  const networkDeadline = new AbortController();
  // Fetch and its response body both reject with this reason; caller cancellation keeps its own reason.
  deadline.addEventListener("abort", () => networkDeadline.abort(new TypeError("Failed to fetch", { cause: deadline.reason })), { once: true });
  const request = new Request(input, { signal: AbortSignal.any([input.signal, networkDeadline.signal]) });
  const key = writable ? (request.headers.get("idempotency-key") ?? crypto.randomUUID()) : undefined;
  if (key) request.headers.set("idempotency-key", key);
  const retry = request.clone();
  try {
    let res = await fetch(withBearer(request));
    noteServerDate(res);
    const stepUp = res.status === 401 && ApiError.fromBody(res, await res.clone().json().catch(() => null)).code.includes("step_up");
    if (res.status === 401 && !stepUp && !NO_REFRESH.some((p) => path.startsWith(p))) {
      const renewed = await refresh().catch((error: unknown) => {
        if (!writable) throw error;
        // The write was refused; an unreachable renewal cannot make its outcome uncertain.
        throw new ApiError(401, "session_renewal_unreachable", "", [], undefined, false, [], {
          requestKey: key, retryAfterMs: error instanceof ApiError ? error.retryAfterMs : undefined,
        });
      });
      // A 401 refused the write before application. Keep its frozen body/key while recovery owns the screen.
      const resumed = !renewed && writable && principal && session.lost && await reauthenticated(principal, input.signal);
      if ((renewed || resumed) && session.principal === principal) {
        res = await fetch(withBearer(retry));
        noteServerDate(res);
      }
    }
    // Resolve interrupted/malformed JSON while the transport still owns the intent key.
    ApiError.withRequestKey(res, key, principal);
    if (res.status === 403) ApiError.fromBody(res, await res.clone().json().catch(() => null));
    if (key && res.status !== 204 && res.headers.get("content-type")?.includes("application/json")) await res.clone().json();
    return res;
  } catch (error) {
    if (input.signal.aborted && request.signal.reason === input.signal.reason) throw error;
    if (!key) throw error;
    if (error instanceof ApiError) throw new ApiError(error.status, error.code, error.message, error.reasons, error.operationId, error.fromServer, error.refusals, { ...error, requestKey: key });
    throw new ApiError(0, "command_unknown", "", [], undefined, false, [], { requestKey: key });
  }
}

// The backend reads a list query parameter as one comma-separated value (`status=A,B`) and rejects
// repeated keys, so arrays are serialized form-style without explode.
const make = (baseUrl: string) => createClient<paths>({ baseUrl, fetch: authFetch, querySerializer: { array: { style: "form", explode: false } } });
/** Typed API client. Rebound by configure(); importers see the new client (ESM live binding). */
export let api = make("");

/** Call once at app start, before any request, with the web or native platform adapter. */
export function configure(p: Platform) {
  setPlatform(p);
  api = make(p.baseUrl || (globalThis.location?.origin ?? ""));
}

/** Unwrap an openapi-fetch result: data or a thrown ApiError. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok) throw ApiError.fromBody(response, error);
  return data as T;
}
