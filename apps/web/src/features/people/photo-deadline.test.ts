// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { configure, DEFAULT_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS } from "@console/api";
import { uploadPhoto } from "./api/record";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("a presigned photo PUT outlives the default deadline but settles without confirming a stalled upload", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Deadline", "TimeoutError")), ms);
    return controller.signal;
  });
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    if (calls.length === 1) return new Response(JSON.stringify({ upload_id: "photo", put: { url: "https://storage.example/photo", method: "PUT", headers: [["content-type", "image/png"]] } }), { headers: { "content-type": "application/json" } });
    return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  });
  let error: unknown;
  void uploadPhoto("person", "2026-01-01T00:00:00Z", new File(["photo"], "photo.png", { type: "image/png" }), String).catch(reason => { error = reason; });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.url).toBe("https://storage.example/photo");
  expect(calls[1]!.headers.has("authorization")).toBe(false);
  expect(await calls[1]!.text()).toBe("photo");
  await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
  expect(error).toBeUndefined();
  expect(calls[1]!.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(LONG_REQUEST_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS);
  expect(error).toBeInstanceOf(TypeError);
  expect(calls).toHaveLength(2);
});
