// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { routeReady } from "../flows";
import { screens } from "../states/registry";
import { screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { holdChunks } from "./chunk-probe";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/org/entities", "/setup/company-names"]) {
  test(`organization navigation and heading paint while the list chunk is held on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await mockScreen(page, screens[2], "empty");
    await mockRoute(page, "get", "/api/v1/entity-identifier-corrections", { status: 200, json: { items: [], next_offset: null } });
    const chunks = await holdChunks(page, ["src/features/entity/ui/entity-routes.tsx"]);
    try {
      await page.goto(path, { waitUntil: "commit" });
      await chunks.requested;
      await expect(page.getByRole("navigation").first()).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: t("structure.title"), exact: true })).toBeVisible();
      const loading = page.locator('main [data-read-layout="list"][aria-busy="true"]');
      await expect(loading).toBeVisible();
      await expect(loading.locator('[aria-hidden="true"]').first()).toHaveCSS("opacity", "1");
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((element, value) => { element.dataset.theme = value; }, theme);
        await fits(page, `${path}/loading/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`loading-${theme}.png`), fullPage: true });
      }
      chunks.release();
      await expect(page.getByRole("main").getByText(t("entity.empty.title"), { exact: true })).toBeVisible();
      await routeReady(page);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      chunks.release();
      await page.close();
      fixture.release();
    }
  });
}

for (const query of ["", "&as_of=2026-10-01&known_at=2026-10-02T00%3A00%3A00Z"]) {
  test(`the entity read overlaps its list chunk and is shared on mount ${query}`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[2], "empty");
    await mockRoute(page, "get", "/api/v1/entity-identifier-corrections", { status: 200, json: { items: [], next_offset: null } });
    const chunks = await holdChunks(page, ["src/features/entity/ui/entity-routes.tsx"]);
    const reads: URL[] = [];
    await mockRoute(page, "get", "/api/v1/legal-entities", request => {
      reads.push(new URL(request.url()));
      return { status: 200, json: { items: [] } };
    });
    try {
      await page.goto(`/org?tab=entities${query}`, { waitUntil: "commit" });
      await chunks.requested;
      await expect.poll(() => reads.length, { message: "the list read must start before its chunk finishes" }).toBe(1);
      expect(reads[0]!.searchParams.get("as_of")).toBe(query ? "2026-10-01" : null);
      expect(reads[0]!.searchParams.get("known_at")).toBe(query ? "2026-10-02T00:00:00Z" : null);
      chunks.release();
      await expect(page.getByRole("main").getByText(t("entity.empty.title"), { exact: true })).toBeVisible();
      await routeReady(page);
      expect(reads).toHaveLength(1);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      chunks.release();
      await page.close();
      fixture.release();
    }
  });
}

for (const state of ["chart", "refused"] as const) {
  test(`${state} does not start the entity list chunk${state === "refused" ? " or read" : ""}`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[2], "empty");
    const requests: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      // The chart reads legal entities itself, so only the refused state can assert the read stays idle.
      const listRead = state === "refused" && path === "/api/v1/legal-entities";
      if (listRead || /\/assets\/entity-routes-[^/]+\.js$/.test(path)) requests.push(path);
    });
    if (state === "refused") await mockRoute(page, "get", "/api/v1/access/me", {
      status: 200, json: { ...screenAccess("/org"), decisions: {}, entries: [] },
    });
    try {
      await page.goto(state === "chart" ? "/org" : "/org?tab=entities");
      await routeReady(page);
      if (state === "chart") await expect(page.getByRole("heading", { level: 1, name: t("structure.title"), exact: true })).toBeVisible();
      else await expect(page.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
      expect(requests).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}

test("bulk entry leaves its disabled entity read idle while the content chunk loads", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "empty");
  const chunks = await holdChunks(page, ["src/features/entity/ui/entity-routes.tsx"]);
  let reads = 0;
  await mockRoute(page, "get", "/api/v1/legal-entities", () => {
    reads++;
    return { status: 200, json: { items: [] } };
  });
  try {
    await page.goto("/org?tab=entities&bulk=paste", { waitUntil: "commit" });
    await chunks.requested;
    await expect(page.getByRole("heading", { level: 1, name: t("structure.title"), exact: true })).toBeVisible();
    await expect(page.locator('main [data-read-layout="list"][aria-busy="true"]')).toBeVisible();
    await expect(page.locator("[data-route-ready]")).toHaveCount(0);
    expect(reads).toBe(0);
    chunks.release();
    await routeReady(page);
    expect(reads).toBe(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    chunks.release();
    await page.close();
    fixture.release();
  }
});
