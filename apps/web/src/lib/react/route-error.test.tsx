// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { CrashConsoleExtras } from "./crash-console-extras";
import { CrashScreen } from "./crash-screen";
import { RouteError } from "./route-error";

beforeAll(() => loadCatalog("ko"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function failedLoader(error: Error) {
  const root = createRootRoute({ component: () => <main data-shell><Outlet /></main> });
  const page = createRoute({ getParentRoute: () => root, path: "/people/import", loader: () => { throw error; }, component: () => null });
  const router = createRouter({ routeTree: root.addChildren([page]), defaultErrorComponent: RouteError,
    history: createMemoryHistory({ initialEntries: ["/people/import"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
}

test.each([401, 503])("a loader ApiError(%s) keeps the shell and offers read retry", async status => {
  const html = await failedLoader(new ApiError(status, "service_unavailable", "unavailable", [], "loader-reference"));
  expect(html).toContain("data-shell");
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).toContain(t("common.retry"));
  expect(html).toContain("loader-reference");
  expect(html).not.toContain(t("common.crashed.title"));
});

test.each([new TypeError("Failed to fetch"), new TypeError("Load failed"), new TypeError("NetworkError when attempting to fetch resource."), new DOMException("timed out", "TimeoutError")])("a loader transport failure offers read retry: %s", async error => {
  expect(await failedLoader(error)).toContain(t("common.loadFailed.title"));
});

test.each([new TypeError("Cannot read properties of undefined"), new Error("render failed")])("a programming error keeps the crash screen: %s", async error => {
  const html = await failedLoader(error);
  expect(html).toContain(t("common.crashed.title"));
  expect(html).not.toContain(t("common.loadFailed.title"));
});

test("CrashScreen keeps baseline free of Console extras and renders status link + input-kept note in Console", () => {
  const baselineHtml = renderToStaticMarkup(<CrashScreen error={new Error("boom")} />);
  expect(baselineHtml).toContain(t("common.crashed.title"));
  expect(baselineHtml).not.toContain(t("live.statusPage"));
  expect(baselineHtml).not.toContain(t("live.crashed.inputKept"));

  const extrasHtml = renderToStaticMarkup(<CrashConsoleExtras />);
  expect(extrasHtml).toContain("https://status.cosskorea.com");
  expect(extrasHtml).toContain(t("live.statusPage"));
  expect(extrasHtml).toContain(t("live.crashed.inputKept"));
});

test("StatusPageLink and CrashConsoleExtras honor VITE_STATUS_ORIGIN while staying decoupled from live.ts", async () => {
  vi.stubEnv("VITE_STATUS_ORIGIN", "https://status.staging.example");
  vi.resetModules();
  const [{ CrashConsoleExtras: CustomExtras }, { StatusPageLink: CustomLink }] = await Promise.all([
    import("./crash-console-extras"),
    import("../../ui/live/status-page-link"),
  ]);
  expect(renderToStaticMarkup(<CustomLink />)).toContain('href="https://status.staging.example"');
  expect(renderToStaticMarkup(<CustomExtras />)).toContain('href="https://status.staging.example"');

  const statusOriginSrc = readFileSync(new URL("../live/status-origin.ts", import.meta.url), "utf8");
  expect(statusOriginSrc).not.toMatch(/from\s+["']/);

  const linkSrc = readFileSync(new URL("../../ui/live/status-page-link.tsx", import.meta.url), "utf8");
  expect(linkSrc).not.toMatch(/\/live(?:["']|\.ts)/);
  expect(linkSrc).not.toMatch(/active-status/);

  const extrasSrc = readFileSync(new URL("./crash-console-extras.tsx", import.meta.url), "utf8");
  expect(extrasSrc).not.toMatch(/\/live(?:["']|\.ts)/);
  expect(extrasSrc).not.toMatch(/active-status/);
});
