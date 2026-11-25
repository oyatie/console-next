// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { failure, structure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { expectAxe, fits } from "../a11y";
import { setLocale } from "../shell";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";

test.beforeAll(() => loadCatalog("ko"));

test("org: a held date read keeps the chart mounted and busy @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  const held = Promise.withResolvers<void>();
  let requested = false;
  try {
    await page.goto("/org");
    const tree = page.getByRole("tree", { name: /조직도$/ });
    await expect(tree).toBeVisible();
    const mounted = await tree.elementHandle();
    await mockRoute(page, "get", "/api/v1/org-structure", async () => {
      requested = true;
      await held.promise;
      return { status: 200, json: structure(3) };
    });
    const trigger = page.getByRole("button", { name: new RegExp(`^${t("asof.label")} · `) });
    await trigger.click();
    const field = page.getByRole("dialog", { name: t("asof.label"), exact: true }).getByRole("textbox", { name: t("asof.label"), exact: true });
    await field.fill("2026-01-01");
    await field.press("Tab");
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator('[data-read-region][aria-busy="true"]').filter({ has: tree })).toBeVisible();
    expect(await mounted!.evaluate(el => el.isConnected)).toBe(true);
    await expect(page.locator("[data-read-layout]")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("main").getByRole("link", { name: t("structure.tools.addEntity"), exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});

// Console draws the fresh chart with no frame and dashes it once the dated read fails; the boards do not draw the org
// screens, so that is the render's value. At 390 it owes only the invariants: the structure and the warning stay.
for (const width of [1440, 390]) test(`org: a failed dated read keeps the last structure at ${width}px in console @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [EXPERIENCE_KEY, "console"] as const);
  const fixture = await mockScreen(page, screens[2], "populated");
  try {
    await page.goto("/org");
    const main = page.getByRole("main");
    // Named before the locale switch; after it the chart carries its English name.
    const tree = main.getByRole("tree");
    const kept = main.getByRole("tree").or(main.getByRole("grid")).first();
    if (width === 390) await expect(kept).toBeVisible();
    else await expect(main.getByRole("tree", { name: new RegExp(`${t("structure.chart.label")}$`) })).toBeVisible();
    const canvas = tree.locator("xpath=ancestor::section[1]");
    const frame = () => canvas.evaluate((el) => {
      const style = getComputedStyle(el);
      return { borderTopStyle: style.borderTopStyle, backgroundColor: style.backgroundColor, borderTopColor: style.borderTopColor };
    });
    await expect(page.locator("[data-dimmed]")).toHaveCount(0);
    const fresh = width === 390 ? undefined : await frame();
    if (fresh) expect(fresh.borderTopStyle).toBe("none");
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 503, json: failure("service_unavailable") });
    await setLocale(page, "en");
    await expect(page.locator('[data-read-region] [data-tone="warn"][role="status"]')).toBeVisible({ timeout: 15_000 });
    await expect(width === 390 ? kept : tree).toBeVisible();
    if (fresh) {
      await expect(page.locator("[data-dimmed]")).toHaveCount(1);
      const stale = await frame();
      expect(stale.borderTopStyle).toBe("dashed");
      expect(stale.backgroundColor).not.toBe(fresh.backgroundColor);
      expect(stale.borderTopColor).not.toBe(fresh.borderTopColor);
    }
    await expectAxe(page, `org/kept-error/${width}/console`);
    await fits(page, `org/kept-error/${width}/console`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const width of [1440, 390]) test(`org: a failed dated read keeps an accessible chart at ${width}px @ui-state @baseline`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  try {
    await page.goto("/org");
    const tree = page.getByRole("tree", { name: /조직도$/ });
    await expect(tree).toBeVisible();
    const canvas = page.locator("section").filter({ has: tree });
    await expect(page.locator("[data-dimmed]")).toHaveCount(0);
    await expect(canvas).toHaveCSS("border-top-style", "solid");
    const fresh = await canvas.evaluate((el) => {
      const style = getComputedStyle(el);
      return { backgroundColor: style.backgroundColor, borderTopColor: style.borderTopColor };
    });
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 503, json: failure("service_unavailable") });
    await setLocale(page, "en");
    await expect(page.locator('[data-read-region] [data-tone="warn"][role="status"]')).toBeVisible({ timeout: 15_000 });
    const dimmed = page.locator("[data-dimmed]");
    await expect(dimmed).toHaveCount(1);
    await expect(dimmed).toHaveCSS("border-top-style", "dashed");
    const stale = await dimmed.evaluate((el) => {
      const style = getComputedStyle(el);
      return { backgroundColor: style.backgroundColor, borderTopColor: style.borderTopColor };
    });
    expect(stale.backgroundColor).not.toBe(fresh.backgroundColor);
    expect(stale.borderTopColor).not.toBe(fresh.borderTopColor);
    await expectAxe(page, `org/kept-error/${width}`);
    await fits(page, `org/kept-error/${width}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("org: retrying failed empty reads restores first registration @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockScreen(page, screens[2], "empty");
  let failed = true;
  for (const path of ["/api/v1/org-structure", "/api/v1/legal-entities"] as const) {
    await page.route(url => url.pathname === path, route => failed
      ? route.fulfill({ status: 503, headers: { "retry-after": "60" }, json: { error: { code: "service_unavailable" } } })
      : route.fallback());
  }
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("/org");
    const main = page.getByRole("main");
    await expect(main.getByRole("alert")).toHaveCount(1);
    failed = false;
    await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
    await expect(main.getByRole("heading", { name: t("structure.first.title"), exact: true })).toBeVisible();
    await expect(main.getByRole("alert")).toHaveCount(0);
    await expect(main.getByRole("link", { name: t("structure.first.addEntity"), exact: true })).toHaveCount(1);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await fits(page, `org recovered empty/${theme}`);
      await expectAxe(page, `org recovered empty/${theme}`);
    }
    expect(errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("org: dated siblings settle together without mixing snapshots @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  const held = Promise.withResolvers<void>();
  try {
    await page.goto("/org");
    await page.getByRole("button", { name: t("structure.depth.all"), exact: true }).click();
    const before = page.getByRole("treeitem", { name: /^검증부서 1,/ });
    await expect(before).toBeVisible();
    const next = structure(3);
    next.entities[0]!.children[0]!.children[0]!.name = "새 시점 부서";
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: next });
    await mockRoute(page, "get", "/api/v1/legal-entities", async () => {
      await held.promise;
      return { status: 200, json: { items: [] } };
    });
    const answered = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/org-structure" && new URL(r.url()).searchParams.has("as_of") && r.ok());
    await page.getByRole("button", { name: new RegExp(`^${t("asof.label")} · `) }).click();
    const field = page.getByRole("dialog", { name: t("asof.label"), exact: true }).getByRole("textbox", { name: t("asof.label"), exact: true });
    await field.fill("2026-01-01");
    await field.press("Tab");
    await answered;
    await expect(before).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /^새 시점 부서,/ })).toHaveCount(0);
    held.resolve();
    await expect(page.getByRole("treeitem", { name: /^새 시점 부서,/ })).toBeVisible();
    await expect(before).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});
