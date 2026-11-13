// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { RouteFrame } from "./route-ready";
import { readyHref } from "./route-href";
vi.mock("./announce", () => ({ useRoutePresentation: vi.fn(), bindAnnouncer: vi.fn() }));
vi.mock("../../ui/announcer", () => ({ Announcer: () => null }));

const state = vi.hoisted(() => ({ location: { href: "/people/person?act=case%3Aevent#case-event", state: { __TSR_key: "entry" } }, status: "idle", isLoading: false, reading: 0 }));
vi.mock("@tanstack/react-router", () => ({ Outlet: () => null, useRouterState: () => state }));
vi.mock("@tanstack/react-query", () => ({ notifyManager: { batchCalls: (fn: unknown) => fn }, useQueryClient: () => ({ getQueryCache: () => ({ subscribe: vi.fn(), findAll: () => Array(state.reading) }) }) }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => number) => snapshot() }));

function marker(browser: string, committed: string) {
  return readyHref(committed, new URL(browser, "https://console.example").href);
}

test.each(["case:event", "name/part", "한 직원", "a b", "a+b", "a&b=c", "%3A"])("ready marker accepts the browser's equivalent query value: %s", (value) => {
  const raw = `/people/person?act=${value.replaceAll("&", "%26").replaceAll("#", "%23")}#case-event`;
  const current = new URL(raw, "https://console.example");
  const encoded = `${current.pathname}?${new URLSearchParams(current.search).toString()}${current.hash}`;
  expect(marker(raw, encoded)).toBe(current.pathname + current.search + current.hash);
});

test.each([
  ["/people/person?act=case:other#case-event", "/people/person?act=case%3Aevent#case-event"],
  ["/people/other?act=case:event#case-event", "/people/person?act=case%3Aevent#case-event"],
  ["/people/person?act=case:event#other", "/people/person?act=case%3Aevent#case-event"],
  ["/people/person?act=a%2Bb", "/people/person?act=a+b"],
])("a different destination never publishes a ready marker (%s)", (browser, committed) => {
  expect(marker(browser, committed)).toBeUndefined();
});

test("server markup cannot claim the screen has rendered in the browser", () => {
  expect(renderToStaticMarkup(<RouteFrame />)).not.toContain("data-route-ready=");
});
