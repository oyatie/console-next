import { afterEach, expect, test, vi } from "vitest";
import { webPlatform } from "./web";

const ORIGIN = "https://console.example";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The refresh endpoint with the browser's shared cookie jar. Like the real server it rotates on use and,
 * when an already-rotated token comes back, treats it as reuse and revokes the whole family.
 */
function fakeServer() {
  let jar = "rt-1";
  let n = 1;
  const live = new Set([jar]);
  const s = { sent: [] as string[], revoked: false };
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url).toBe(`${ORIGIN}/api/v1/auth/token/refresh`);
    const cookie = jar; // the browser attaches the cookie when the request leaves
    s.sent.push(cookie);
    await new Promise((r) => setTimeout(r, 5)); // latency, so concurrent refreshes really overlap
    if (s.revoked || !live.delete(cookie)) {
      s.revoked = true;
      return json(401, { error: { code: "refresh_token_reused", message: "reused" } });
    }
    jar = `rt-${++n}`;
    live.add(jar);
    return json(200, { access_token: `at-${n}`, token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
  });
  return s;
}

/** navigator.locks stand-in: one exclusive queue, recording the lock names asked for. */
function fakeLocks() {
  const names: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const request = (name: string, _options: LockOptions, fn: () => Promise<unknown>) => {
    names.push(name);
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
  vi.stubGlobal("navigator", { locks: { request } });
  return names;
}

/** A tab is its own module instance: its own in-memory session and single-flight state. */
async function openTab() {
  vi.resetModules();
  const tab = await import("./index");
  tab.configure({ ...webPlatform, baseUrl: ORIGIN });
  return tab;
}

test("two tabs restored together both stay signed in: the second waits and sends the rotated cookie", async () => {
  const names = fakeLocks();
  const server = fakeServer();
  const [a, b] = [await openTab(), await openTab()];

  expect(await Promise.all([a.refresh(), b.refresh()])).toEqual([true, true]);
  expect(server.sent).toEqual(["rt-1", "rt-2"]);
  expect(server.revoked).toBe(false);
  expect([a.session.token, b.session.token]).toEqual(["at-2", "at-3"]);
  expect(names).toEqual(["console-refresh", "console-refresh"]);
});

test("without the lock the same restore trips reuse detection and signs a tab out (the bug)", async () => {
  vi.stubGlobal("navigator", {});
  const server = fakeServer();
  const [a, b] = [await openTab(), await openTab()];

  expect(await Promise.all([a.refresh(), b.refresh()])).toEqual([true, false]);
  expect(server.sent).toEqual(["rt-1", "rt-1"]);
  expect(server.revoked).toBe(true);
  expect(b.session.token).toBeNull();
});

test("concurrent refreshes in one tab share one network call", async () => {
  fakeLocks();
  const server = fakeServer();
  const tab = await openTab();

  expect(await Promise.all([tab.refresh(), tab.refresh(), tab.refresh()])).toEqual([true, true, true]);
  expect(server.sent).toEqual(["rt-1"]);
  expect(tab.session.token).toBe("at-2");
});

test("a failed rotation releases the lock, so the next tab still gets its turn", async () => {
  fakeLocks();
  let calls = 0;
  vi.stubGlobal("fetch", async () => (++calls === 1 ? json(503, {}) : json(200, { access_token: "at", token_type: "Bearer", refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false })));
  const [a, b] = [await openTab(), await openTab()];

  // The 503 rejects (a fault, not a refused session: tab a keeps its session) and still releases the lock.
  const [ra, rb] = await Promise.allSettled([a.refresh(), b.refresh()]);
  expect(ra.status).toBe("rejected");
  expect(rb).toEqual({ status: "fulfilled", value: true });
  expect(b.session.token).toBe("at");
});

test("a lock never granted (a frozen tab holds it) times out and refreshes unguarded, exactly once", async () => {
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  const request = (_name: string, { signal }: LockOptions) =>
    new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason)));
  vi.stubGlobal("navigator", { locks: { request } });
  const fn = vi.fn(async () => "rotated");

  const result = webPlatform.withRefreshLock!(fn);
  expect(fn).not.toHaveBeenCalled();
  timeout.abort(new DOMException("timed out", "TimeoutError"));
  expect(await result).toBe("rotated");
  expect(fn).toHaveBeenCalledTimes(1);
});

test("a granted lock whose refresh fails is not retried: the failure propagates", async () => {
  fakeLocks();
  const fn = vi.fn(async () => {
    throw new Error("rotation failed");
  });

  await expect(webPlatform.withRefreshLock!(fn)).rejects.toThrow("rotation failed");
  expect(fn).toHaveBeenCalledTimes(1);
});
