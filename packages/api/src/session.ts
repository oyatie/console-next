import type { components } from "./schema";
import { platform } from "./platform";

export type TokenPair = components["schemas"]["TokenPairResponse"];
type ErrorBody = components["schemas"]["ErrorBody"]["error"] & { operation_id?: string; original_operation_id?: string; refusals?: Refusal[]; details?: Record<string, unknown>; last_change?: LastChange | null };
/** One refused item of an all-or-nothing batch (bulk_lifecycle_refused). */
export type Refusal = { employee_id: string; code: string; message: string };
/** One refused input of a refusal (`error.errors[]`): which field and the domain code why. */
export type FieldError = components["schemas"]["FieldError"];
/** Latest authorized mutation metadata; field values never travel in a conflict. */
export type LastChange = {
  actor_name: string | null;
  actor_kind: "TENANT_USER" | "OPS_ACCOUNT" | "GROUP_ADMIN" | "SUPPORT_OPERATOR" | "SYSTEM" | null;
  recorded_at: string | null;
  fields: string[];
  audit_id: string | null;
  redacted: boolean;
};
const requestKeys = new WeakMap<Response, string>();
/** What a refusal carries besides its code and message. */
export type ErrorExtras = {
  /** Diagnostic correlation issued by the server; absent for network failures. */
  traceId?: string;
  supportRef?: string;
  supportRefAt?: string;
  /** Field-level refusals (`error.errors[]`). */
  errors?: FieldError[];
  /** The refusal's facts by name (`error.details`), e.g. the lock that refused a dated write. */
  details?: Record<string, unknown>;
  /** The server's `Retry-After` (a 503 shed or a 429), in milliseconds from when it answered. */
  retryAfterMs?: number;
  /** The transport's original intent key, preserved when its outcome is unknown. */
  requestKey?: string;
  lastChange?: LastChange;
  originalOperationId?: string;
};

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; absent or unreadable is undefined. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/** Backend error envelope `{error:{code,message,reasons?,operation_id?,errors?,details?}}` as a throwable. */
export class ApiError extends Error {
  readonly traceId?: string;
  readonly supportRef?: string;
  readonly supportRefAt?: string;
  readonly errors: FieldError[];
  readonly details: Record<string, unknown>;
  readonly retryAfterMs?: number;
  readonly requestKey?: string;
  readonly lastChange?: LastChange;
  readonly originalOperationId?: string;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reasons: string[] = [],
    readonly operationId?: string,
    /** False when the response carried no error envelope: `message` is then only HTTP status text. */
    readonly fromServer = true,
    readonly refusals: Refusal[] = [],
    extras: ErrorExtras = {},
  ) {
    super(message);
    this.traceId = extras.traceId;
    this.supportRef = extras.supportRef;
    this.supportRefAt = extras.supportRefAt;
    this.errors = extras.errors ?? [];
    this.details = extras.details ?? {};
    this.retryAfterMs = extras.retryAfterMs;
    this.requestKey = extras.requestKey;
    this.lastChange = extras.lastChange;
    this.originalOperationId = extras.originalOperationId;
  }

  /** Keep the native response intact, including its URL and immutable headers. */
  static withRequestKey(res: Response, key?: string): Response {
    if (key) requestKeys.set(res, key);
    return res;
  }

  static async from(res: Response): Promise<ApiError> {
    return ApiError.fromBody(res, await res.json().catch(() => null));
  }

  /** From an already-parsed body (openapi-fetch consumes the response stream). */
  static fromBody(res: Response, body: unknown): ApiError {
    const e = (body as { error?: ErrorBody } | null)?.error;
    return new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? res.statusText, e?.reasons, e?.operation_id ?? res.headers.get("operation-id") ?? undefined, Boolean(e?.message), e?.refusals, {
      traceId: e?.trace_id,
      supportRef: e?.support_ref,
      supportRefAt: e?.support_ref_at,
      errors: e?.errors,
      details: e?.details,
      retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
      requestKey: requestKeys.get(res),
      lastChange: e?.last_change ?? undefined,
      originalOperationId: e?.original_operation_id,
    });
  }
}

// Access token lives in memory only; the refresh token is the HttpOnly `console_refresh`
// cookie (Path=/api/v1/auth), so a reload recovers the session via refresh().
let accessToken: string | null = null;
/** Sent on every request so the server can localize its messages. */
let acceptLanguage = "ko";
export const setAcceptLanguage = (tag: string) => void (acceptLanguage = tag);
export const languageHeader = () => acceptLanguage;
let passkeySetupRequired = false;
let privacyConsentAccepted = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Routing hints decoded from the access token. The server re-verifies every request. */
export type Claims = {
  sub: string;
  org: string;
  name?: string;
  roles: string[];
  platform: boolean;
  read_only: boolean;
  /** A one-time-code session: the server lets it reach only consent, passkey registration, refresh and sign-out. */
  enrollment?: boolean;
  /** Expiry, Unix seconds on the server's clock. */
  exp?: number;
};
function decode(token: string | null): Claims | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    const bytes = Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Claims;
  } catch {
    return null;
  }
}
let claims: Claims | null = null;
/** The session ended without a sign-out (idle timeout, revoked family): the app keeps its screens for re-auth. */
let lost = false;
/** Why the server ended the session (the refused refresh's code, e.g. `session_idle_expired`), until the next sign-in. */
let ended: string | null = null;

// INF-03: the server advances a session's activity only from `X-Last-Interaction` (the last real user input),
// so polls never keep an idle session alive. `skew` (server minus client clock, from responses' `Date`) keeps a
// slow PC clock from reading as idle.
let lastInteraction: number | null = null;
let skew = 0;
/** Record a real user input (pointer, key, touch). */
export const touch = (at = Date.now()) => void (lastInteraction = at);
/** This context's last recorded input, on the client clock. */
export const lastTouch = () => lastInteraction;
/** Learn the server clock from a response's `Date` header (second precision; the server clamps to its own now). */
export function noteServerDate(res: Response) {
  const at = Date.parse(res.headers.get("date") ?? "");
  if (!Number.isNaN(at)) skew = at - Date.now();
}
/** When a request last carried the input to the server (client clock), or 0: the activity ping's throttle. */
let reportedAt = 0;
export const lastReported = () => reportedAt;
/** The header for authenticated requests; none before the first input (a missing header never advances activity). */
export function interactionHeaders(): Record<string, string> {
  if (lastInteraction === null) return {};
  reportedAt = Date.now();
  return { "x-last-interaction": new Date(lastInteraction + skew).toISOString() };
}

/** How long before the access token expires it is renewed: past a hidden tab's throttled timers (up to a minute). */
export const RENEW_LEAD_MS = 2 * 60_000;
/**
 * Milliseconds from `now` (client clock) until the token expiring at `expSec` (server clock) is renewed, `lead` before
 * its expiry; null when it lives no longer than that (a family near its absolute cap, where renewing gains nothing:
 * the next request refreshes as before).
 */
export function renewDelay(expSec: number | undefined, now: number, skewMs: number, lead = RENEW_LEAD_MS): number | null {
  if (expSec === undefined) return null;
  const left = expSec * 1000 - skewMs - now;
  return left > lead ? left - lead : null;
}
let renewal: ReturnType<typeof setTimeout> | undefined;
/**
 * Renews the access token before it expires, so the event stream (closed by the server at expiry) and the next request
 * never meet a 401. Through refresh(): one rotation across tabs (the platform lock), never while the session is lost,
 * and refused once the server ended an idle session (renewal carries no input, so it keeps nothing alive).
 */
function scheduleRenewal() {
  clearTimeout(renewal);
  const delay = accessToken ? renewDelay(claims?.exp, Date.now(), skew) : null;
  renewal = delay === null ? undefined : setTimeout(() => void refresh().catch(() => undefined), delay);
}

export const session = {
  /** Session routing hint; the server still enforces current consent on protected writes. */
  get consentAccepted() {
    return privacyConsentAccepted;
  },
  setConsentAccepted(accepted: boolean) {
    privacyConsentAccepted = accepted;
    emit();
  },
  /** Tenant and account together own drafts and interrupted writes. */
  get principal() {
    return claims ? JSON.stringify([claims.org, claims.sub]) : null;
  },
  get token() {
    return accessToken;
  },
  get claims() {
    return claims;
  },
  /**
   * Where this session belongs, from the token's own authority and the server's passkey state.
   * "enroll": a one-time-code session that still has to register a passkey. "app": a passkey session.
   * "stale": the two disagree (registration finished but the passkey sign-in never followed, or an
   * admin reset this user's passkeys under a live session); only signing in again recovers it.
   */
  /** True between an involuntary session end and the next sign-in; `claims` still name who was signed in. */
  get lost() {
    return lost;
  },
  /** The refusal code that ended the session (`session_idle_expired`: signed out for inactivity), or null. */
  get ended() {
    return ended;
  },
  get stage(): "enroll" | "app" | "stale" {
    const enrolling = Boolean(claims?.enrollment);
    return enrolling !== passkeySetupRequired ? "stale" : enrolling ? "enroll" : "app";
  },
  set(pair: TokenPair | null) {
    accessToken = pair?.access_token ?? null;
    claims = decode(accessToken);
    passkeySetupRequired = pair?.requires_passkey_setup ?? false;
    privacyConsentAccepted = pair?.privacy_consent_accepted === true;
    lost = false;
    ended = null;
    scheduleRenewal();
    emit();
  },
  /**
   * The server ended the session (refresh refused). A signed-in session becomes `lost`; a cold start, or a one-time-code
   * session (it can only enroll a passkey, so it has no drafts and no passkey to sign back in with), just has none.
   */
  expire(reason: string | null = null) {
    lost = claims !== null && !claims.enrollment;
    ended = reason;
    accessToken = null;
    if (!lost) claims = null;
    scheduleRenewal();
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** Wait only for the interrupted account; sign-out, replacement or cancellation abandons the write. */
export function reauthenticated(principal: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const finish = (same: boolean) => {
      off();
      signal.removeEventListener("abort", abort);
      resolve(same);
    };
    const abort = () => {
      off();
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const check = () => {
      if (session.principal !== principal) finish(false);
      else if (session.token) finish(session.stage === "app");
      else if (!session.lost) finish(false);
    };
    const off = session.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

/**
 * Auth endpoint call. On web, opts into the cookie transport so the refresh token never reaches JS.
 * Bearer calls (consent, passkey enrollment) refresh once on 401 and retry, like authFetch.
 */
export async function authPost<T>(path: string, body?: unknown, bearer = false): Promise<T> {
  const p = platform();
  const send = () => {
    const headers: Record<string, string> = { "content-type": "application/json", "accept-language": acceptLanguage };
    if (p.refresh.kind === "cookie") headers["x-auth-transport"] = "cookie";
    if (bearer && accessToken) Object.assign(headers, { authorization: `Bearer ${accessToken}` }, interactionHeaders());
    return fetch(p.baseUrl + path, {
      method: "POST",
      headers,
      credentials: p.refresh.kind === "cookie" ? "same-origin" : "omit",
      body: JSON.stringify(body ?? {}),
    });
  };
  let res = await send();
  noteServerDate(res);
  if (res.status === 401 && bearer && (await refresh())) {
    res = await send();
    noteServerDate(res);
  }
  if (!res.ok) throw await ApiError.from(res);
  const data = (res.status === 204 ? undefined : await res.json()) as T;
  // Native transport: persist the rotated refresh token wherever one is returned.
  const rotated = (data as { refresh_token?: string | null } | undefined)?.refresh_token;
  if (p.refresh.kind === "body" && rotated) await p.refresh.save(rotated);
  return data;
}

let inflight: Promise<boolean> | null = null;
/**
 * Single-flight refresh: concurrent 401s share one rotation, and the platform lock serializes it
 * across tabs. Resolves false when the session is gone (the server refused it with 401). A network
 * error, 429 or 5xx rejects instead and never ends the session (decisions #8c). While the session is
 * lost, nothing is sent: only a sign-in restores it.
 */
export function refresh(): Promise<boolean> {
  if (lost) return Promise.resolve(false);
  inflight ??= (async () => {
    const p = platform();
    const rotate = async () => {
      const t = p.refresh;
      const refresh_token = t.kind === "body" ? await t.load() : undefined;
      if (t.kind === "body" && !refresh_token) return false;
      session.set(await authPost<TokenPair>("/api/v1/auth/token/refresh", { refresh_token }));
      return true;
    };
    return p.withRefreshLock ? p.withRefreshLock(rotate) : rotate();
  })()
    .catch((e: unknown) => {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      session.expire(e.code);
      return false;
    })
    .finally(() => (inflight = null));
  return inflight;
}

/** Native transport: the stored refresh token, so logout can revoke its family server-side. */
export async function storedRefresh(): Promise<string | undefined> {
  const t = platform().refresh;
  return t.kind === "body" ? ((await t.load()) ?? undefined) : undefined;
}

/** Sign-out clears the native keystore copy too. */
export async function clearStoredRefresh() {
  const t = platform().refresh;
  if (t.kind === "body") await t.save(null);
}
