// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as client from "./client";
import { openEventStream } from "./events";
import { session } from "./session";

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
  const fetch = vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
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
  expect(fetch.mock.calls[0]![0].signal.aborted).toBe(false);
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
