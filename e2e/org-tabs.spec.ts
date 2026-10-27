// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "./a11y";
import { failure, id, structure } from "./mock/fixtures";
import { mockRoute } from "./mock/route";
import { mockEntityRecord } from "./states/entity-record";
import { routeReady } from "./flows";

test.beforeAll(() => loadCatalog("ko"));
const tabNav = (page: Page) => page.getByRole("navigation", { name: t("structure.tabs"), exact: true });
const tabLink = (page: Page, key: "chart" | "entities" | "changes") => tabNav(page).getByRole("link", { name: t(`structure.tab.${key}`), exact: true });
// Compare painted pixels; variable-font shaping can change fractional advances without moving a pixel.
const pixelBox = (locator: Locator) => locator.evaluate(element => {
  const { x, y, width, height } = element.getBoundingClientRect();
  const pixel = (value: number) => Math.round(value * devicePixelRatio) / devicePixelRatio;
  return { x: pixel(x), y: pixel(y), width: pixel(width), height: pixel(height) };
});

async function fixture(page: Page) {
  const shell = await mockEntityRecord(page, "populated");
  const tree = structure(3);
  tree.entities[0]!.id = shell.entity.id;
  tree.entities[0]!.children[0]!.id = shell.entity.workplaces[0]!.id;
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [shell.entity] } });
  await mockRoute(page, "get", "/api/v1/entity-identifier-corrections", { status: 200, json: { items: [], next_offset: null } });
  await page.route("**/api/v1/entity-identifier-corrections/X", route => route.fulfill({ status: 404, json: failure("not_found") }));
  await mockRoute(page, "get", "/api/v1/org-structure/batches", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/entity-setup/batches", { status: 200, json: { items: [] } });
  return shell;
}

const redirects = [
  ["/org/entities?add=true#entities-title", "entities", { tab: "entities", add: "true" }, "#entities-title"],
  ["/org/entities?correction=X#identifier-corrections", "entities", { tab: "entities", correction: "X" }, "#identifier-corrections"],
  ["/org/entities?bulk=paste", "entities", { tab: "entities", bulk: "paste" }, ""],
  ["/org/entities?as_of=2026-10-01&known_at=2026-10-02T00%3A00%3A00Z", "entities", { tab: "entities", as_of: "2026-10-01", known_at: "2026-10-02T00:00:00Z" }, ""],
  ["/org/entities/bulk?mode=import", "entities", { tab: "entities", bulk: "import" }, ""],
  ["/setup/company-names", "entities", { tab: "entities" }, ""],
  ["/org/changes?view=approval&effective_from=2026-10-01&effective_to=2026-10-31#changes", "changes", { tab: "changes", filter: "approval", effective_from: "2026-10-01", effective_to: "2026-10-31" }, "#changes"],
  ["/org/history", "changes", { tab: "changes", filter: "history" }, ""],
  ["/org/history?as_of=2026-10-01#history", "changes", { as_of: "2026-10-01", tab: "changes", filter: "history" }, "#history"],
] as const;

for (const [path, tab, search, hash] of redirects) test(`legacy ${path} reaches its view`, async ({ page }) => {
  await fixture(page);
  await page.goto(path);
  await expect(tabLink(page, tab)).toHaveAttribute("aria-current", "page");
  const url = new URL(page.url());
  expect(url.pathname).toBe("/org");
  expect(Object.fromEntries(url.searchParams)).toEqual(search);
  expect(url.hash).toBe(hash);
  if ("filter" in search && search.filter === "history") await expect(page.getByRole("button", { name: t("orgChange.list.view.history"), exact: true })).toHaveAttribute("aria-pressed", "true");
  if ("add" in search) {
    await expect(page.locator("#entities-title")).toHaveAttribute("tabindex", "-1");
    await expect(page.getByRole("dialog")).toBeVisible();
  }
});

test("redirect and tab switches replace history; other tabs' controls are dropped", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await routeReady(page);
  await page.goto("/org/entities");
  await expect(tabLink(page, "entities")).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/org?tab=entities&correction=X&as_of=2026-10-01&known_at=2026-10-02T00%3A00%3A00Z");
  for (const key of ["changes", "chart", "entities"] as const) {
    await tabLink(page, key).click();
    await expect(tabLink(page, key)).toHaveAttribute("aria-current", "page");
    const search = new URL(page.url()).searchParams;
    expect(search.get("as_of")).toBe("2026-10-01");
    expect(search.get("known_at")).toBe("2026-10-02T00:00:00Z");
    expect(search.has("correction")).toBe(false);
    expect(search.has("view")).toBe(false);
    expect(search.has("filter")).toBe(false);
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test("an unknown tab uses the chart; a no-grant legacy reader gets one refusal", async ({ page }) => {
  await fixture(page);
  await page.goto("/org?tab=x");
  await expect(tabLink(page, "chart")).toHaveAttribute("aria-current", "page");
  await routeReady(page);
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: id(1), is_ops: false, phase: "SETUP", as_of: "2026-10-27T00:00:00Z", entries: [] } });
  await page.goto("/org/entities", { waitUntil: "commit" });
  await expect(page.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toHaveCount(1);
  await expect(page).toHaveURL(/\/org\?tab=entities$/);
});

test("record and creation deep links keep their existing screens", async ({ page }) => {
  await fixture(page);
  const paths = [
    `/org/changes/${id(3000)}?unsent=1`,
    `/org/entities/${id(4100)}?tab=workplaces&wp=${id(4102)}`,
    "/org/entities/new?kind=CORPORATION",
  ];
  for (const path of paths) {
    await page.goto(path);
    await routeReady(page);
    expect(new URL(page.url()).pathname).toBe(path.split("?")[0]);
    await expect(tabNav(page)).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveCount(1);
  }
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: id(1), is_ops: true, phase: "SETUP", as_of: "2026-10-27T00:00:00Z", entries: [] } });
  await page.goto(`/org/entities/${id(4100)}/workplaces/new`);
  await expect(page).toHaveURL(new RegExp(`/org\\?sel=${id(4100)}&act=wp-create$`));
  await expect(page.getByRole("dialog")).toBeVisible();
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) test(`stable page head and accessible panels at ${width} ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
  await fixture(page);
  await page.goto("/org");
  await routeReady(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const boxes = async () => ({ head: await pixelBox(page.locator("#structure-title")), nav: await pixelBox(tabNav(page)) });
  const initial = await boxes();
  await page.evaluate(() => {
    const state = window as typeof window & { orgTabCls: number | null };
    state.orgTabCls = null;
    if (!PerformanceObserver.supportedEntryTypes.includes("layout-shift")) return;
    state.orgTabCls = 0;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!entry.hadRecentInput) state.orgTabCls! += entry.value;
    }).observe({ type: "layout-shift" });
  });
  for (const key of ["entities", "changes", "chart"] as const) {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = key === "entities" ? "/api/v1/legal-entities" : key === "changes" ? "/api/v1/org-changes" : "/api/v1/org-structure";
    await page.route(url => url.pathname === read, async route => { await held; await route.fallback(); });
    try {
      await tabLink(page, key).click();
      await expect(tabLink(page, key)).toHaveAttribute("aria-current", "page");
      expect(await boxes()).toEqual(initial);
      release();
      await routeReady(page);
      expect(await boxes()).toEqual(initial);
      await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveCount(1);
      await fits(page, `org/${key}/${width}/${theme}`);
      if (key === "chart" && width === 390) {
        const phase = page.locator("p[data-phase]");
        const screenshot = test.info().outputPath("org-chart-mobile.png");
        await page.screenshot({ fullPage: true, path: screenshot });
        await test.info().attach("org-chart-mobile", { path: screenshot, contentType: "image/png" });
        expect(await phase.evaluate(el => el.scrollWidth - el.clientWidth), "the phase explanation fits").toBe(0);
        const canvas = await page.getByRole("region", { name: t("structure.chart.label"), exact: true }).boundingBox();
        expect(canvas!.x).toBeGreaterThanOrEqual(initial.head.x);
        expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(width);
        const root = await page.getByRole("region", { name: t("structure.chart.label"), exact: true }).getByRole("treeitem").first().boundingBox();
        expect(root!.x, "the chart's leading label starts inside the canvas").toBeGreaterThanOrEqual(canvas!.x);
      }
      await expectAxe(page, `org/${key}/${width}/${theme}`);
    } finally { release(); }
  }
  await tabLink(page, "changes").click();
  await page.getByRole("button", { name: t("orgChange.list.view.history"), exact: true }).click();
  await routeReady(page);
  expect(await boxes()).toEqual(initial);
  await expectAxe(page, `org/history/${width}/${theme}`);
  const cls = await page.evaluate(() => (window as typeof window & { orgTabCls: number | null }).orgTabCls);
  await test.info().attach("org-tab-layout", { body: JSON.stringify({ width, theme, cls, boxes: initial }), contentType: "application/json" });
  if (cls !== null) expect(cls).toBeLessThanOrEqual(0.01);
  else test.info().annotations.push({ type: "CLS", description: "Layout Instability API unavailable; bounding boxes checked across every panel." });
});
