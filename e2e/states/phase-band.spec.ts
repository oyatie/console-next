// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { checklist, failure, screenAccess, structure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

const receiptSettings = (days: number) => ({ can_change: false, items: [{
  key: "onboarding.receipt_days", kind: { type: "int" as const, unit: "days" as const },
  default: days, value: days, looser_when: "neutral" as const, governance: "tenant" as const,
  legal_basis: null, version: "code_default" as const, effective_from: null, scheduled: [],
  source: { layer: "code_default" as const, scope_entity_id: null }, chain: [],
}] });

for (const width of [1440, 390]) {
  test(`phase gallery: loading, setup and readable receipt at ${width} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/_gallery?entry=phase-band");
    const examples = page.locator("[data-phase-example]");
    await expect(examples).toHaveCount(3);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      for (const example of await examples.all()) {
        const slot = example.locator("[data-phase-band]");
        await expect(slot).toBeVisible();
        const bounds = await slot.boundingBox();
        for (const button of await slot.getByRole("button").all()) {
          const box = await button.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
          expect(box!.y).toBeGreaterThanOrEqual(bounds!.y);
          expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
          expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
        }
      }
      expect(await page.getByRole("main").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
      await expectAxe(page, `phase gallery/${width}/${theme}`);
    }
    const receipt = page.locator('[data-phase-example="receipt"]');
    await expect(receipt.getByText(t("setup.receipt.started.detail"), { exact: true })).toBeVisible();
    await receipt.getByRole("button", { name: t("setup.phase.dismiss"), exact: true }).click();
    await expect(receipt.locator("[data-phase-band]")).toHaveCount(0);
  });

  test(`late setup checklist keeps the next step under the heading at ${width} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    const fixture = await mockScreen(page, screens[1], "populated");
    const held = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/people", "SETUP") });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
      await held.promise;
      return { status: 200, json: { ...checklist, phase: "SETUP" as const, steps: [{
        key: "entity", group: "company" as const, state: "todo" as const, count: 0, can_act: true, skippable: false,
        action: "create_legal_entity", remedy: "create_legal_entity", paths: ["one" as const], needs: "",
        counts: { entities: 0, workplaces: 0, units: 0, people: 0, unplaced: 0, entity_unknown: 0 },
      }] } };
    });
    try {
      await page.goto("/people");
      const head = page.getByRole("main").locator("header").first();
      const slot = head.locator("[data-phase-band]");
      await expect(slot).toHaveAttribute("data-phase-band", "setup");
      await page.evaluate(() => document.fonts.ready);
      const before = await head.boundingBox();
      await page.evaluate(clearShifts);
      held.resolve();
      await expect(slot).toContainText(t("setup.step.entity"));
      expect(await head.boundingBox()).toEqual(before);
      await expectStable(page, `late setup/${width}`);
      await fits(page, `late setup/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); await page.close(); fixture.release(); }
  });

  for (const path of ["/people", "/org"]) test(`${path}: one readable receipt under h1, dismissible across reloads at ${width} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[path === "/people" ? 1 : 2], "populated");
    await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: receiptSettings(2) });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: { ...checklist, go_live_at: new Date().toISOString() } });
    try {
      await page.goto(path);
      const main = page.getByRole("main"), slot = main.locator("[data-phase-band]");
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await expect(slot).toHaveCount(1);
        const detail = slot.getByText(t("setup.receipt.started.detail"), { exact: true });
        await expect(detail).toBeVisible();
        await expect(detail).not.toHaveAttribute("title");
        expect(await detail.evaluate(el => el.scrollWidth === el.clientWidth)).toBe(true);
        expect(await slot.evaluate(el => !!el.previousElementSibling?.querySelector("h1"))).toBe(true);
        await expect(main.locator('[data-phase="operating"]')).toHaveCount(0);
        await fits(page, `receipt/${path}/${width}/${theme}`);
        await expectAxe(page, `receipt/${path}/${width}/${theme}`);
      }
      if (path === "/org" && width === 1440) {
        expect(await main.getByRole("tree").evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThanOrEqual(0.8);
        const region = await main.getByRole("region", { name: t("structure.chart.label"), exact: true }).boundingBox();
        const tree = await main.getByRole("tree").boundingBox();
        expect(tree!.y + tree!.height).toBeLessThanOrEqual(region!.y + region!.height);
        expect(tree!.y + tree!.height).toBeLessThanOrEqual(900);
      }
      await page.emulateMedia({ media: "print" });
      await expect(slot).toBeHidden();
      await expect(page.getByRole("link", { name: t("shell.skip"), includeHidden: true })).toBeHidden();
      await page.emulateMedia({ media: "screen" });
      await slot.getByRole("button", { name: t("setup.phase.dismiss"), exact: true }).click();
      await expect(slot).toHaveCount(0);
      await page.reload();
      await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(slot).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const phase of ["SETUP", "OPERATING"] as const) test(`org: readable first view with ${phase === "SETUP" ? "setup" : "no phase notice"} at 1440 @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  const data = structure(3);
  data.phase = phase;
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", phase) });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: { ...checklist, phase } });
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: data });
  try {
    await page.goto("/org");
    const main = page.getByRole("main"), tree = main.getByRole("tree");
    await expect(tree).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(main.locator("[data-phase-band]")).toHaveCount(phase === "SETUP" ? 1 : 0);
    expect(await tree.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThanOrEqual(0.8);
    const region = await main.getByRole("region", { name: t("structure.chart.label"), exact: true }).boundingBox();
    const workplace = await tree.getByRole("treeitem", { name: new RegExp(`^${data.entities[0]!.children[0]!.name},`) }).boundingBox();
    expect(workplace!.y).toBeGreaterThanOrEqual(region!.y);
    expect(workplace!.y + workplace!.height).toBeLessThanOrEqual(region!.y + region!.height);
    expect(workplace!.y + workplace!.height).toBeLessThanOrEqual(900);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const state of ["legacy", "expired", "disabled", "missing-setting", "checklist-503", "checklist-403"] as const) {
  test(`operating ${state}: no permanent phase or extra error @ui-state`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[2], "populated");
    if (state !== "missing-setting") await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: receiptSettings(state === "disabled" ? 0 : 2) });
    await page.route("**/api/v1/onboarding/checklist", route => route.fulfill(
      state.startsWith("checklist-") ? { status: state === "checklist-503" ? 503 : 403, json: failure(state === "checklist-503" ? "service_unavailable" : "forbidden") }
        : { json: { ...checklist, go_live_at: state === "legacy" ? null : state === "expired" ? new Date(Date.now() - 3 * 86400000).toISOString() : new Date().toISOString() } },
    ));
    try {
      const response = page.waitForResponse("**/api/v1/onboarding/checklist");
      await page.goto("/org");
      await response;
      await expect(page.getByRole("tree")).toBeVisible();
      await expect(page.getByRole("main").locator("[data-phase-band]")).toHaveCount(0);
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("a receipt expires at the configured boundary without navigation @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  const now = new Date();
  await page.clock.install({ time: now });
  await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: receiptSettings(2) });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: { ...checklist, go_live_at: now.toISOString() } });
  try {
    await page.goto("/people");
    const slot = page.getByRole("main").locator("[data-phase-band]");
    await expect(slot).toHaveCount(1);
    await page.clock.fastForward(2 * 86400000 + 1);
    await expect(slot).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
