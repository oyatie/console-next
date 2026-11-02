// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { structure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { expectAxe, fits } from "../a11y";

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
