// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { routeReady } from "../flows";
import { mockEntityRecord } from "../states/entity-record";
import { mockEntityCreate } from "../states/entity";
import { PORTS } from "../slot";
import { structure } from "./fixtures";
import { mockRoute } from "./route";

test.beforeAll(() => loadCatalog("ko"));

for (const [width, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]] as const) {
  test(`the entity list does not wait for record and registration code at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    const fixture = await mockEntityRecord(page, "populated");
    const tree = structure(3);
    tree.entities[0]!.id = fixture.entity.id;
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [fixture.entity] } });
    await mockRoute(page, "get", "/api/v1/entity-identifier-corrections", { status: 200, json: { items: [], next_offset: null } });
    let requests = 0;
    let release!: () => void;
    let held = new Promise<void>(resolve => { release = resolve; });
    let wizard: Awaited<ReturnType<typeof mockEntityCreate>> | undefined;
    const manifest = JSON.parse(readFileSync(`.cache/states-${PORTS.web}/.vite/manifest.json`, "utf8")) as Record<string, { file: string }>;
    for (const name of ["entity-record", "entity-wizard"]) expect(manifest[`src/features/entity/ui/${name}.tsx`]).toBeDefined();
    const chunks = new Set(["entity-record", "entity-wizard"].map(name => `/${manifest[`src/features/entity/ui/${name}.tsx`]!.file}`));
    await page.route(url => chunks.has(url.pathname), async route => {
      requests++;
      await held;
      await route.continue();
    });
    try {
      await page.goto("/org/entities");
      const grid = page.getByRole("grid", { name: t("entity.list.table"), exact: true });
      await expect(grid.locator("[data-row-id]")).toHaveCount(1);
      await routeReady(page);
      expect(requests).toBe(0);
      await fits(page, `entity-list/${width}/${theme}`);
      await expectAxe(page, `entity-list/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("entity-list.png"), fullPage: true });
      await grid.getByRole("rowheader").first().press("Enter");
      await expect.poll(() => requests).toBe(1);
      const recordLoading = page.locator('[data-read-layout="record"][role="status"][aria-busy="true"]');
      await expect(recordLoading).toBeVisible();
      await expect(recordLoading.locator('[aria-hidden="true"]').first()).toHaveCSS("opacity", "1");
      await fits(page, `entity-record-loading/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("entity-record-loading.png"), fullPage: true });
      release();
      await expect(page).toHaveURL(new RegExp(`/org/entities/${fixture.entity.id}$`));
      await expect(page.getByRole("tablist", { name: t("entityRecord.tabs"), exact: true })).toBeVisible();
      await routeReady(page);
      await fits(page, `entity-record/${width}/${theme}`);
      await expectAxe(page, `entity-record/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("entity-record.png"), fullPage: true });
      wizard = await mockEntityCreate(page);
      held = new Promise<void>(resolve => { release = resolve; });
      await page.goto("/org/entities/new?kind=CORPORATION");
      await expect.poll(() => requests).toBe(2);
      const wizardLoading = page.locator('[data-read-layout="form"][role="status"][aria-busy="true"]');
      await expect(wizardLoading).toBeVisible();
      await expect(wizardLoading.locator('[aria-hidden="true"]').first()).toHaveCSS("opacity", "1");
      await fits(page, `entity-wizard-loading/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("entity-wizard-loading.png"), fullPage: true });
      release();
      await expect(page.getByRole("heading", { name: t("entityCreate.title"), level: 1, exact: true })).toBeVisible();
      await routeReady(page);
      await fits(page, `entity-wizard/${width}/${theme}`);
      await expectAxe(page, `entity-wizard/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("entity-wizard.png"), fullPage: true });
      expect(requests).toBe(2);
      expect(wizard.unexpected).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      release();
      wizard?.release();
      fixture.release();
      await page.close();
    }
  });
}

test("a cold entity record loads its graph without the list chunk or a second import hop", async ({ page }) => {
  const fixture = await mockEntityRecord(page, "populated");
  const manifest = JSON.parse(readFileSync(`.cache/states-${PORTS.web}/.vite/manifest.json`, "utf8")) as Record<string, { file: string; imports?: string[] }>;
  const listChunk = `/${manifest["src/features/entity/ui/entity-routes.tsx"]!.file}`;
  const record = manifest["src/features/entity/ui/entity-record.tsx"]!;
  expect(record).toBeDefined();
  const graph = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key]!;
    if (graph.has(`/${chunk.file}`)) return;
    graph.add(`/${chunk.file}`);
    chunk.imports?.forEach(visit);
  };
  visit("src/features/entity/ui/entity-record.tsx");
  const requested: string[] = [];
  page.on("request", request => requested.push(new URL(request.url()).pathname));
  try {
    await page.goto(`/org/entities/${fixture.entity.id}`);
    await expect(page.getByRole("tablist", { name: t("entityRecord.tabs"), exact: true })).toBeVisible();
    await routeReady(page);
    expect(requested).not.toContain(listChunk);
    const timing = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => entry.toJSON())) as { name: string; startTime: number; responseEnd: number }[];
    const route = timing.find(entry => new URL(entry.name).pathname === `/${record.file}`)!;
    expect(route).toBeDefined();
    const late = timing.filter(entry => graph.has(new URL(entry.name).pathname) && entry.startTime > route.responseEnd);
    expect(late.map(entry => new URL(entry.name).pathname)).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
