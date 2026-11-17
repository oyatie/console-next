// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { routeReady } from "../flows";
import { orgChangeScreens } from "../states/registry";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { holdChunks } from "./chunk-probe";
import { inbox, screenAccess } from "./fixtures";
import { homeSetupChecklist } from "../states/home-setup";
import { previewData } from "./onboarding";

test.beforeAll(() => loadCatalog("ko"));

test("organization record preload metadata stays behind the lazy organization route", async ({ request, page }) => {
  const html = await (await request.get("/")).text();
  const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)![1]!;
  const source = await (await request.get(entry)).text();
  expect(source.match(/assets\/OrgChange-[^" ]+/g) ?? []).toEqual([]);
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, orgChangeScreens[1], "draft");
  try {
    await page.goto(orgChangeScreens[1].path);
    await routeReady(page);
    await expect(page.locator("#change-title")).toBeVisible();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await fits(page, `record/390/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
    }
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const path of ["/org/changes", "/org/history"]) for (const width of [1440, 390]) {
  test(`organization list fits on ${path} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, orgChangeScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/org-structure/batches", { status: 200, json: { items: [] } });
    await mockRoute(page, "get", "/api/v1/entity-setup/batches", { status: 200, json: { items: [] } });
    try {
      await page.goto(path);
      await routeReady(page);
      const main = page.getByRole("main");
      if (path === "/org/history") await expect(main.getByText(t("orgHistory.foot", { count: 3 }), { exact: true })).toBeVisible();
      else await expect(main.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
        await fits(page, `${path}/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

const historyReads = ["/api/v1/org-structure/batches", "/api/v1/entity-setup/batches", "/api/v1/org-changes", "/api/v1/org-structure"];

for (const chunk of ["src/features/org/ui/org-changes.tsx", "src/features/org-bulk/ui/history-page.tsx"]) {
  test(`history reads overlap ${chunk} and are shared on mount`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await mockScreen(page, orgChangeScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/org-structure/batches", { status: 200, json: { items: [] } });
    await mockRoute(page, "get", "/api/v1/entity-setup/batches", { status: 200, json: { items: [] } });
    const chunks = await holdChunks(page, [chunk]);
    const reads: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (historyReads.includes(url.pathname) && (url.pathname !== "/api/v1/org-changes" || (url.searchParams.get("limit") === "200" && !url.searchParams.has("drafted_by")))) reads.push(url.pathname);
    });
    try {
      await page.goto("/org/history", { waitUntil: "commit" });
      await chunks.requested;
      await expect.poll(() => [...reads].sort(), { message: "all history reads must start before the held chunk finishes" }).toEqual([...historyReads].sort());
      await expect(page.getByRole("heading", { level: 1, name: t("structure.title"), exact: true })).toBeVisible();
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
        await fits(page, `history/loading/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`loading-${theme}.png`), fullPage: true });
      }
      chunks.release();
      await expect(page.getByRole("main").getByText(t("orgHistory.foot", { count: 3 }), { exact: true })).toBeVisible();
      await routeReady(page);
      expect([...reads].sort()).toEqual([...historyReads].sort());
      expect(fixture.unexpected).toEqual([]);
    } finally { chunks.release(); await page.close(); fixture.release(); }
  });
}

for (const state of ["changes", "refused", "intent"] as const) {
  test(`${state} leaves history batch reads idle`, async ({ page }) => {
    const fixture = await mockScreen(page, orgChangeScreens[0], "empty");
    const reads: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (historyReads.slice(0, 2).includes(path)) reads.push(path);
    });
    const chunks = state === "intent" ? await holdChunks(page, ["src/routes/org-tabs.tsx"]) : undefined;
    if (state === "intent") {
      const checklist = homeSetupChecklist("first");
      await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: checklist });
      await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(0), setup: checklist } });
      await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", { status: 200, json: previewData("ready") });
    }
    if (state === "refused") await mockRoute(page, "get", "/api/v1/access/me", {
      status: 200, json: { ...screenAccess("/org"), decisions: {}, entries: [] },
    });
    try {
      await page.goto(state === "refused" ? "/org/history" : state === "intent" ? "/" : "/org/changes");
      await routeReady(page);
      if (state === "intent") {
        const link = page.getByRole("link", { name: t("setup.bulk.history"), exact: true });
        await link.hover();
        await chunks!.requested;
        const preloaded = page.waitForResponse(response => new URL(response.url()).pathname === chunks!.requests[0]);
        chunks!.release();
        await (await preloaded).finished();
        expect(new URL(page.url()).pathname).toBe("/");
      }
      if (state === "refused") await expect(page.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
      expect(reads).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { chunks?.release(); await page.close(); fixture.release(); }
  });
}
