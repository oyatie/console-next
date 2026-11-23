// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as client from "./client";
import { openEventStream } from "./events";
import { ApiError, authPost, session } from "./session";
import { consentStatus } from "./auth";

beforeEach(() => {
  vi.useFakeTimers();
  // Native timeout timers do not use the JS clock; keep their abort semantics under fake time.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Deadline", "TimeoutError")), ms);
    return controller.signal;
  });
  client.configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
});

afterEach(() => {
  session.set(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function holdFetch() {
  const fetch = vi.fn((input: Request | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const request = new Request(input, init);
    if (request.signal.aborted) reject(request.signal.reason);
    else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function outcome<T>(promise: Promise<T>) {
  const result: { value?: T; error?: unknown } = {};
  void promise.then(value => { result.value = value; }, error => { result.error = error; });
  return result;
}

test("an unanswered read becomes the existing network failure at the default deadline", async () => {
  const fetch = holdFetch();
  const result = outcome(client.unwrap(client.api.GET("/api/v1/users/me")));
  await vi.advanceTimersByTimeAsync(0);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(client.DEFAULT_REQUEST_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS - 1);
  expect(result.error).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(result.error).toBeInstanceOf(TypeError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(["deadline", "caller"])("a stalled response body preserves the %s failure shape", async source => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", async (request: Request) => new Response(new ReadableStream({ start(body) {
    body.enqueue(new TextEncoder().encode('{"id":'));
    request.signal.addEventListener("abort", () => body.error(request.signal.reason), { once: true });
  } }), { headers: { "content-type": "application/json" } }));
  const result = outcome(client.unwrap(client.api.GET("/api/v1/users/me", { signal: controller.signal })));
  await vi.advanceTimersByTimeAsync(0);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(client.DEFAULT_REQUEST_TIMEOUT_MS);
  if (source === "caller") controller.abort();
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS);
  if (source === "deadline") expect(result.error).toBeInstanceOf(TypeError);
  else expect(result.error).toBe(controller.signal.reason);
});

test.each(["GET", "POST"])("a caller's %s abort retains its reason instead of becoming a network failure", async method => {
  holdFetch();
  session.set({ access_token: "token", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const controller = new AbortController();
  const result = outcome(client.authFetch(new Request("https://console.example/api/v1/users/me", { method, signal: controller.signal })));
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toBe(controller.signal.reason);
  expect(result.error).toMatchObject({ name: "AbortError" });
  expect(AbortSignal.timeout).toHaveBeenCalledWith(client.DEFAULT_REQUEST_TIMEOUT_MS);
});

test("an unanswered write keeps its intent key and uncertain-outcome error", async () => {
  holdFetch();
  session.set({ access_token: "token", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  const result = outcome(client.authFetch(new Request("https://console.example/api/v1/report", { method: "POST", headers: { "idempotency-key": "original-intent" } })));
  await vi.advanceTimersByTimeAsync(0);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(client.DEFAULT_REQUEST_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS);
  expect(result.error).toMatchObject({ status: 0, code: "command_unknown", requestKey: "original-intent" });
});

const longCalls = [
  ["POST", "/api/v1/entity-documents"],
  ["POST", "/api/v1/employees/import/preview"],
  ["GET", "/api/v1/employees/export.csv"],
  ["GET", "/api/v1/statutory/worker-register/export"],
  ["GET", "/api/v1/entity-documents/document/content"],
] as const;

test.each(longCalls)("%s %s gets a longer finite deadline, including with a query string", async (method, path) => {
  const fetch = holdFetch();
  const result = outcome(client.authFetch(new Request(`https://console.example${path}?purpose=review`, { method })));
  expect(AbortSignal.timeout).toHaveBeenCalledWith(client.LONG_REQUEST_TIMEOUT_MS);
  expect(client.LONG_REQUEST_TIMEOUT_MS).toBeGreaterThan(client.DEFAULT_REQUEST_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS);
  expect(new Request(...fetch.mock.calls[0]!).signal.aborted).toBe(false);
  expect(result.error).toBeUndefined();
  await vi.advanceTimersByTimeAsync(client.LONG_REQUEST_TIMEOUT_MS - client.DEFAULT_REQUEST_TIMEOUT_MS);
  expect(result.error).toBeInstanceOf(TypeError);
});

test.each([
  ["GET", "/api/v1/entity-documents"],
  ["POST", "/api/v1/employees/export.csv"],
  ["GET", "/api/v1/entity-documents/document/content/other"],
])("%s %s does not inherit a neighboring long-call exception", async (method, path) => {
  holdFetch();
  const result = outcome(client.authFetch(new Request(`https://console.example${path}`, { method })));
  expect(AbortSignal.timeout).toHaveBeenCalledWith(client.DEFAULT_REQUEST_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS);
  expect(result.error).toBeInstanceOf(TypeError);
});

test("a healthy event stream outlives request deadlines under its heartbeat watchdog", async () => {
  holdFetch();
  const read = outcome(client.authFetch(new Request("https://console.example/api/v1/users/me")));
  let signal!: AbortSignal;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = openEventStream({
    url: "https://console.example/api/v1/events", token: () => null, refresh: async () => false, onFrame: () => {},
    tune: { retryHint: 1000, reconnectBackoffMax: 30_000, backoffResetAfter: 30_000, heartbeatInterval: 25_000, deadAfterHeartbeats: 2 },
    fetch: async (_url, init) => {
      signal = init.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        body = controller;
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(24_000);
      body.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(read.error).toBeInstanceOf(TypeError);
    expect(stream.get().state).toBe("live");
    expect(signal.aborted).toBe(false);
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(1);
  } finally {
    stream.close();
  }
});

const pair = () => ({ access_token: `h.${btoa(JSON.stringify({ sub: "user", org: "tenant" }))}.s`, token_type: "Bearer" as const, refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test.each(["resume", "abort"])("a frozen write can %s after a long re-sign-in wait", async action => {
  const caller = new AbortController();
  session.set(pair());
  const attempts: Request[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/refresh")) return json(401, { error: { code: "session_expired" } });
    attempts.push(request);
    if (request.signal.aborted) throw request.signal.reason;
    return attempts.length === 1 ? json(401, { error: { code: "unauthorized" } }) : json(200, { saved: true });
  });
  const result = outcome(client.authFetch(new Request("https://console.example/api/v1/report", { method: "POST", headers: { "idempotency-key": "held-intent" }, body: "frozen input", signal: caller.signal })));
  await vi.advanceTimersByTimeAsync(0);
  expect(session.lost).toBe(true);
  await vi.advanceTimersByTimeAsync(2 * client.DEFAULT_REQUEST_TIMEOUT_MS);
  expect(attempts).toHaveLength(1);
  expect(result.error).toBeUndefined();
  if (action === "abort") {
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.error).toBe(caller.signal.reason);
    session.set(pair());
    expect(attempts).toHaveLength(1);
    return;
  }
  session.set(pair());
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toBeUndefined();
  expect(result.value?.status).toBe(200);
  expect(attempts.map(request => request.headers.get("idempotency-key"))).toEqual(["held-intent", "held-intent"]);
  expect(await attempts[1]!.text()).toBe("frozen input");
});

test.each(["GET", "POST", "consent"])("a slow 401 and refresh leave the retried %s its full deadline", async method => {
  session.set(pair());
  const attempts: Request[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/refresh")) {
      await new Promise(resolve => setTimeout(resolve, client.DEFAULT_REQUEST_TIMEOUT_MS * 0.6));
      return json(200, pair());
    }
    attempts.push(request);
    if (request.signal.aborted) throw request.signal.reason;
    if (attempts.length === 1) {
      await new Promise(resolve => setTimeout(resolve, client.DEFAULT_REQUEST_TIMEOUT_MS * 0.6));
      return json(401, { error: { code: "unauthorized" } });
    }
    return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  });
  const result = outcome<unknown>(method === "consent" ? consentStatus() : client.authFetch(new Request("https://console.example/api/v1/report", { method, headers: { "idempotency-key": "slow-intent" } })));
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS * 1.2);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.signal.aborted).toBe(false);
  expect(result.error).toBeUndefined();
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS - 1);
  expect(result.error).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  if (method !== "POST") expect(result.error).toBeInstanceOf(TypeError);
  else expect(result.error).toMatchObject({ code: "command_unknown", requestKey: "slow-intent" });
});

test.each(["GET", "POST"])("the server's 30 s refusal and Retry-After reach a %s caller", async method => {
  session.set(pair());
  vi.stubGlobal("fetch", async (request: Request) => new Promise<Response>((resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    setTimeout(() => resolve(new Response(JSON.stringify({ error: { code: "unavailable", message: "Request timed out" } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "2" } })), 30_050);
  }));
  const result = outcome(client.authFetch(new Request("https://console.example/api/v1/report", { method })).then(async response => { throw await ApiError.from(response); }));
  await vi.advanceTimersByTimeAsync(30_050);
  expect(result.error).toMatchObject({ status: 503, code: "unavailable", retryAfterMs: 2000, fromServer: true });
});

test("a caller abort after a write's deadline keeps the uncertain outcome and intent key", async () => {
  session.set(pair());
  const caller = new AbortController();
  let rejectFetch!: (error: unknown) => void;
  let deadlineError: unknown;
  vi.stubGlobal("fetch", (request: Request) => new Promise<Response>((_resolve, reject) => {
    rejectFetch = reject;
    request.signal.addEventListener("abort", () => { deadlineError = request.signal.reason; }, { once: true });
  }));
  const result = outcome(client.authFetch(new Request("https://console.example/api/v1/report", { method: "POST", signal: caller.signal, headers: { "idempotency-key": "late-abort-intent" } })));
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS);
  expect(deadlineError).toBeInstanceOf(TypeError);
  caller.abort();
  rejectFetch(deadlineError);
  await vi.advanceTimersByTimeAsync(0);
  expect(result.error).toMatchObject({ code: "command_unknown", requestKey: "late-abort-intent" });
});

test.each(["/api/v1/auth/token/refresh", "/api/v1/auth/otp/redeem", "/api/v1/auth/passkey/login/start", "/api/v1/auth/passkey/login/finish", "/api/v1/auth/logout", "consent"])("unanswered auth call %s reaches the network error", async path => {
  holdFetch();
  const result = outcome(path === "consent" ? consentStatus() : authPost(path));
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS);
  expect(result.error).toBeInstanceOf(TypeError);
});

test("the post-sign-in consent response body is also bounded", async () => {
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    return new Response(new ReadableStream({ start(body) {
      body.enqueue(new TextEncoder().encode('{"accepted":'));
      request.signal.addEventListener("abort", () => body.error(request.signal.reason), { once: true });
    } }), { headers: { "content-type": "application/json" } });
  });
  const result = outcome(consentStatus());
  await vi.advanceTimersByTimeAsync(client.DEFAULT_REQUEST_TIMEOUT_MS);
  expect(result.error).toBeInstanceOf(TypeError);
});

test("30s server timeout plus transport slack and deadline timeout detection match contract", () => {
  expect(client.SERVER_REQUEST_TIMEOUT_MS).toBe(30_000);
  expect(client.TRANSPORT_SLACK_MS).toBe(15_000);
  expect(client.DEFAULT_REQUEST_TIMEOUT_MS).toBe(45_000);
  const timeoutCause = new DOMException("Deadline", "TimeoutError");
  const wrapped = new TypeError("Failed to fetch", { cause: timeoutCause });
  expect(client.isDeadlineTimeout(wrapped)).toBe(true);
  expect(client.isDeadlineTimeout(new TypeError("Failed to fetch"))).toBe(false);
  expect(client.isDeadlineTimeout(new DOMException("Aborted", "AbortError"))).toBe(false);
});
