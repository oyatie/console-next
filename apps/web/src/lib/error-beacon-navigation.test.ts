// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const source = readFileSync(new URL("../../public/error-beacon.js", import.meta.url), "utf8");

function load() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const sent: { kind: string }[] = [];
  const window = { addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; } };
  runInNewContext(source, {
    window, location: { pathname: "/login" },
    document: { querySelectorAll: () => [] },
    navigator: { sendBeacon: (_url: string, data: string) => { sent.push(JSON.parse(data)); return true; } },
    setTimeout: () => {},
  });
  return { listeners, sent };
}

test("navigation cancellation reports stop at pagehide and resume after a bfcache restore", () => {
  const { listeners, sent } = load();
  const failures = () => {
    listeners["vite:preloadError"]!({ payload: new TypeError("aborted import") });
    listeners.unhandledrejection!({ reason: new TypeError("aborted import") });
    listeners.error!({ target: { tagName: "LINK", rel: "modulepreload" } });
  };
  failures();
  expect(sent.map(body => body.kind)).toEqual(["preload", "rejection", "resource"]);
  listeners.pagehide?.({ persisted: true });
  failures();
  expect(sent).toHaveLength(3);
  listeners.pageshow?.({ persisted: true });
  failures();
  expect(sent.map(body => body.kind)).toEqual(["preload", "rejection", "resource", "preload", "rejection", "resource"]);
});

test("Firefox's import rejection before pagehide does not consume the report cap or deduplication", () => {
  const { listeners, sent } = load();
  listeners.beforeunload?.({});
  const failure = new TypeError("aborted import");
  for (let i = 0; i < 12; i++) listeners["vite:preloadError"]!({ payload: failure });
  listeners.unhandledrejection!({ reason: failure });
  expect(sent).toEqual([]);
  listeners.pagehide?.({ persisted: true });
  listeners.pageshow?.({ persisted: true });
  listeners.unhandledrejection!({ reason: failure });
  expect(sent.map(body => body.kind)).toEqual(["rejection"]);
});
