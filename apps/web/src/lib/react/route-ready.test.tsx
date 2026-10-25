// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { RouteFrame } from "./route-ready";

const state = vi.hoisted(() => ({ location: { href: "/people/person?act=case%3Aevent#case-event", state: { __TSR_key: "entry" } }, status: "idle", isLoading: false, reading: 0 }));
vi.mock("@tanstack/react-router", () => ({ Outlet: () => null, useRouterState: () => state }));
vi.mock("@tanstack/react-query", () => ({ notifyManager: { batchCalls: (fn: unknown) => fn }, useQueryClient: () => ({ getQueryCache: () => ({ subscribe: vi.fn(), findAll: () => Array(state.reading) }) }) }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => number) => snapshot() }));
afterEach(() => { vi.unstubAllGlobals(); state.status = "idle"; state.isLoading = false; state.reading = 0; });

function marker(browser: string, committed: string) {
  vi.stubGlobal("window", { location: new URL(browser, "https://console.example") });
  state.location.href = committed;
  return renderToStaticMarkup(<RouteFrame />);
}

test.each(["case:event", "name/part", "한 직원", "a b", "a+b", "a&b=c", "%3A"])("ready marker accepts the browser's equivalent query value: %s", (value) => {
  const raw = `/people/person?act=${value.replaceAll("&", "%26").replaceAll("#", "%23")}#case-event`;
  const current = new URL(raw, "https://console.example");
  const encoded = `${current.pathname}?${new URLSearchParams(current.search).toString()}${current.hash}`;
  const html = marker(raw, encoded);
  expect(html).toContain(`data-route-ready="${current.pathname + current.search + current.hash}"`);
  expect(html).toContain('data-route-key="entry"');
});

test.each([
  ["/people/person?act=case:other#case-event", "/people/person?act=case%3Aevent#case-event"],
  ["/people/other?act=case:event#case-event", "/people/person?act=case%3Aevent#case-event"],
  ["/people/person?act=case:event#other", "/people/person?act=case%3Aevent#case-event"],
  ["/people/person?act=a%2Bb", "/people/person?act=a+b"],
])("a different destination never publishes a ready marker (%s)", (browser, committed) => {
  expect(marker(browser, committed)).not.toContain("data-route-ready=");
});

test.each(["status", "isLoading", "reading"] as const)("the marker still waits for %s", (pending) => {
  if (pending === "status") state.status = "pending";
  if (pending === "isLoading") state.isLoading = true;
  if (pending === "reading") state.reading = 1;
  expect(marker("/people/person?act=case:event", "/people/person?act=case%3Aevent")).not.toContain("data-route-ready=");
});
