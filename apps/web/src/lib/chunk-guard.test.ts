import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test } from "vitest";
import { isModuleNotFoundError } from "@tanstack/router-core";
import { i18n, t } from "@console/i18n";
import { chunk, isChunkError } from "./chunk-guard";

const SRC = readFileSync(new URL("../../public/chunk-guard.js", import.meta.url), "utf8");
type Guard = { recover(): boolean; loaded(): void; start(): void };

/** One page load of public/chunk-guard.js over a tab's sessionStorage: what it navigated to, and its API. */
function page(storage: Map<string, string>, entry = "/assets/index-A.js", search = "") {
  const navigations: string[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const loc = { pathname: "/account", search, hash: "", replace: (u: string) => navigations.push(u) };
  const history = { state: null, replaceState: (_: unknown, __: string, u: string) => void (loc.search = u.includes("?") ? u.slice(u.indexOf("?")) : "") };
  const sessionStorage = {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
  const window = { addEventListener: (type: string, f: (e: unknown) => void) => (listeners[type] = f) } as Record<string, unknown>;
  const document = { querySelectorAll: () => [{ src: `http://localhost${entry}` }] };
  runInNewContext(SRC, { window, document, location: loc, history, sessionStorage, Date });
  return { navigations, listeners, loc, guard: window.consoleChunkGuard as Guard };
}

test("a missing chunk reloads once per build, with a fetch of index.html that a stale cache cannot answer", () => {
  const tab = new Map<string, string>();
  const first = page(tab);
  expect(first.guard.recover()).toBe(true);
  expect(first.guard.recover()).toBe(true); // a second failure while it goes is the same reload
  expect(first.navigations).toHaveLength(1);
  expect(first.navigations[0]).toMatch(/^\/account\?_r=\d+$/);

  // The reloaded page strips the parameter before the router reads it, and fails again: no second reload.
  const second = page(tab, "/assets/index-A.js", first.navigations[0]!.slice("/account".length));
  expect(second.loc.search).toBe("");
  expect(second.guard.recover()).toBe(false);
  expect(second.navigations).toHaveLength(0);
  second.guard.loaded(); // a page that gave up is no success: the guard stays
  expect(page(tab).guard.recover()).toBe(false);

  // Another build (the other colour of a blue/green pair) has its own key, and alternating builds still stop.
  const other = page(tab, "/assets/index-B.js");
  expect(other.guard.recover()).toBe(true);
  expect(page(tab, "/assets/index-B.js").guard.recover()).toBe(false);
  expect(page(tab, "/assets/index-A.js").guard.recover()).toBe(false);
});

test("a page that loads clears the guard, so a later deploy reloads once again", () => {
  const tab = new Map<string, string>();
  expect(page(tab).guard.recover()).toBe(true);
  page(tab, "/assets/index-B.js").guard.loaded();
  expect(tab.size).toBe(0);
  expect(page(tab).guard.recover()).toBe(true);
  // A reload under way is not a success either.
  const going = page(tab, "/assets/index-C.js");
  going.guard.recover();
  going.guard.loaded();
  expect(page(tab, "/assets/index-C.js").guard.recover()).toBe(false);
});

test("the busting parameter keeps the rest of the query as it was written", () => {
  const p = page(new Map(), "/assets/index-A.js", "?q=%EA%B0%80+b&view=all");
  p.guard.recover();
  expect(p.navigations[0]).toMatch(/^\/account\?q=%EA%B0%80\+b&view=all&_r=\d+$/);
  expect(page(new Map(), "/assets/index-A.js", "?view=all&_r=123").loc.search).toBe("?view=all");
});

test("entry assets that fail before the entry runs reload; after it runs, lazy chunks are the bundle's to handle", () => {
  const boot = page(new Map());
  boot.listeners.error!({ target: { tagName: "LINK", rel: "modulepreload" } });
  expect(boot.navigations).toHaveLength(1);
  const running = page(new Map());
  running.guard.start();
  running.listeners.error!({ target: { tagName: "LINK", rel: "modulepreload" } });
  running.listeners.error!({ target: { tagName: "IMG" } });
  expect(running.navigations).toHaveLength(0);
  // A build's own preload helper reports a failed dynamic import: reload once.
  running.listeners["vite:preloadError"]!({});
  expect(running.navigations).toHaveLength(1);
});

test("the static error screen says what the app's crashed screen says", () => {
  for (const l of ["en", "ko"] as const) {
    i18n.set(l);
    for (const id of ["common.crashed.title", "common.crashed.reason", "common.crashed.action"] as const) expect(SRC).toContain(`"${t(id)}"`);
  }
});

afterEach(() => void delete (globalThis as { consoleChunkGuard?: unknown }).consoleChunkGuard);

test("a lazy import reloads through the guard, then fails with an error TanStack's own reload does not act on", async () => {
  const gone = new Error("Failed to fetch dynamically imported module: http://localhost/assets/Account-X.js");
  expect(isChunkError(gone) && isModuleNotFoundError(gone)).toBe(true);
  expect(isChunkError(new Error("Importing a module script failed."))).toBe(true);
  expect(isChunkError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
  expect(isChunkError(new TypeError("x is not a function"))).toBe(false);

  let reloads = 0;
  (globalThis as { consoleChunkGuard?: unknown }).consoleChunkGuard = { recover: () => ++reloads === 1 };
  const pending = await Promise.race([chunk(Promise.reject(gone)).then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 20))]);
  expect(pending).toBe("pending"); // the page is going: the screen stays suspended, never an error flash
  const after = await chunk(Promise.reject(gone)).catch((e: Error) => e);
  expect(after).toBeInstanceOf(Error);
  expect(isModuleNotFoundError(after)).toBe(false);
  expect((after as Error).cause).toBe(gone);
  // Not a missing chunk (e.g. the module threw while evaluating): passed through, no reload.
  const other = new TypeError("boom");
  await expect(chunk(Promise.reject(other))).rejects.toBe(other);
  expect(reloads).toBe(2);
});
