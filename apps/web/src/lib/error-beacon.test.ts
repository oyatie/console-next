import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const SRC = readFileSync(new URL("../../public/error-beacon.js", import.meta.url), "utf8");
type Beacon = { kind: string; build: string; route: string; name?: string };

/** One page load of public/error-beacon.js: its listeners, its timers and what it sent. */
function page({ path = "/people", entry = "/assets/index-AbC_12-x.js", beacon = true } = {}) {
  const sent: { url: string; body: Beacon }[] = [];
  const fetched: { url: string; init: { keepalive?: boolean } }[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const docListeners: Record<string, (() => void) | undefined> = {};
  const timers: (() => void)[] = [];
  const root = { firstElementChild: null as unknown };
  const document = {
    visibilityState: "visible",
    querySelectorAll: () => [{ src: `http://localhost${entry}` }],
    getElementById: (id: string) => (id === "root" ? root : null),
    addEventListener: (t: string, f: () => void) => (docListeners[t] = f),
    removeEventListener: (t: string) => (docListeners[t] = undefined),
  };
  const navigator = beacon ? { sendBeacon: (url: string, data: string) => (sent.push({ url, body: JSON.parse(data) }), true) } : {};
  const fetch = (url: string, init: { body: string; keepalive?: boolean }) => {
    fetched.push({ url, init });
    sent.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve();
  };
  const window = { addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f) };
  const location = { pathname: path, search: "?q=secret", hash: "#also-secret" };
  runInNewContext(SRC, { window, document, navigator, fetch, location, WeakSet, JSON, setTimeout: (f: () => void) => timers.push(f) });
  const fire = () => timers.splice(0).forEach((f) => f());
  return { sent, fetched, listeners, docListeners, root, document, fire };
}

test("an uncaught error sends the kind, build, route pattern and constructor name, never the message", () => {
  const p = page({ path: "/people/123e4567-e89b-12d3-a456-426614174000/record" });
  p.listeners.error!({ target: {}, error: new TypeError("홍길동 010-1234-5678") });
  expect(p.sent).toEqual([{ url: "/api/v1/client-errors", body: { kind: "error", build: "AbC_12-x", route: "/people/:id/record", name: "TypeError" } }]);
  expect(JSON.stringify(p.sent)).not.toMatch(/홍길동|010|secret/);
});

test("ids are collapsed: numbers, UUIDs, long tokens and encoded or non-ASCII segments; plain words stay", () => {
  const route = (path: string) => {
    const p = page({ path });
    p.listeners.unhandledrejection!({ reason: "x" });
    return p.sent[0]!.body.route;
  };
  expect(route("/people/42")).toBe("/people/:id");
  expect(route("/org/units/ab12cd34ef56gh78/edit")).toBe("/org/units/:id/edit");
  expect(route("/t/%ED%99%8D%EA%B8%B8%EB%8F%99")).toBe("/t/:id");
  expect(route("/x/" + "a".repeat(40))).toBe("/x/:id");
  expect(route("/structure/workplace-close")).toBe("/structure/workplace-close");
  expect(route("/")).toBe("/");
  expect(route("/a".repeat(50)).length).toBe(64);
});

test("kinds: rejection, preload, resource (module script, modulepreload, stylesheet); other resources are ignored", () => {
  const p = page();
  p.listeners.unhandledrejection!({ reason: new RangeError("r") });
  p.listeners["vite:preloadError"]!({ payload: new Error("p") });
  p.listeners.error!({ target: { tagName: "SCRIPT", type: "module" } });
  p.listeners.error!({ target: { tagName: "LINK", rel: "modulepreload" } });
  p.listeners.error!({ target: { tagName: "LINK", rel: "stylesheet" } });
  p.listeners.error!({ target: { tagName: "IMG" } });
  p.listeners.error!({ target: { tagName: "SCRIPT", type: "" } });
  expect(p.sent.map((s) => s.body.kind)).toEqual(["rejection", "preload", "resource", "resource", "resource"]);
  expect(p.sent[0]!.body.name).toBe("RangeError");
  expect(p.sent[2]!.body).not.toHaveProperty("name");
});

test("the same error object is reported once (a preload error Vite rethrows as a rejection)", () => {
  const p = page();
  const e = new Error("gone");
  p.listeners["vite:preloadError"]!({ payload: e });
  p.listeners.unhandledrejection!({ reason: e });
  expect(p.sent).toHaveLength(1);
});

test("at most 10 beacons per page load", () => {
  const p = page();
  for (let i = 0; i < 25; i++) p.listeners.error!({ target: {}, error: new Error(String(i)) });
  expect(p.sent).toHaveLength(10);
});

test("the build is the entry hash, or dev under the dev server; a bad name is dropped", () => {
  const p = page({ entry: "/src/main.tsx" });
  p.listeners.unhandledrejection!({ reason: { name: "Not a name!" } });
  expect(p.sent[0]!.body).toEqual({ kind: "rejection", build: "dev", route: "/people" });
});

test("without sendBeacon it posts with fetch keepalive", () => {
  const p = page({ beacon: false });
  p.listeners.unhandledrejection!({ reason: "x" });
  expect(p.fetched).toEqual([{ url: "/api/v1/client-errors", init: expect.objectContaining({ method: "POST", keepalive: true }) }]);
});

test("boot watchdog: an empty #root after 15 s is a boot failure; a rendered one is not", () => {
  const empty = page();
  empty.fire();
  expect(empty.sent.map((s) => s.body.kind)).toEqual(["boot"]);

  const rendered = page();
  rendered.root.firstElementChild = {};
  rendered.fire();
  expect(rendered.sent).toHaveLength(0);
});

test("boot watchdog counts only visible time: hidden at the deadline, it re-arms when the page shows", () => {
  const p = page();
  p.document.visibilityState = "hidden";
  p.fire();
  expect(p.sent).toHaveLength(0);
  p.document.visibilityState = "visible";
  p.docListeners.visibilitychange!();
  expect(p.docListeners.visibilitychange).toBeUndefined();
  p.fire(); // 15 s after it showed
  expect(p.sent.map((s) => s.body.kind)).toEqual(["boot"]);
});
