// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { go } from "../flows";
import { previewData } from "./onboarding";
import { screens } from "../states/registry";
import { authz, checklist, modules, screenAccess, user } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const phase of ["OPERATING", "SETUP"] as const) {
  test(`rail confirms current ${phase} entries before showing a stale saved rail at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    const fixture = await mockScreen(page, screens[1], "empty");
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    const access = { ...screenAccess("/people", phase), is_ops: true };
    const savedPhase = phase === "SETUP" ? "OPERATING" : "SETUP";
    await page.addInitScript(({ key, answer }) => localStorage.setItem(key, JSON.stringify(answer)), {
      key: `console.nav.${JSON.stringify([authz.org_id, user.id])}`,
      answer: { access, supportApproval: false, context: { pathname: "/people", phase: savedPhase,
        setupTargets: ["/org", "/people", "/access"], modules: modules.ready } },
    });
    await mockRoute(page, "get", "/api/v1/access/me", async () => {
      requested.resolve();
      await held.promise;
      return { status: 200, json: access };
    });
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { ...user.tenant!, phase } } });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: {
      ...checklist, phase, steps: [{ key: "people", group: "people", state: "todo", action: "register_employee",
        skippable: false, counts: { entities: 1, workplaces: 1, units: 1, people: 0, unplaced: 0, entity_unknown: 0 },
        paths: ["one"], can_act: true, needs: "" }],
      done: 0, total: 1, go_live_at: null,
    } });
    try {
      await page.goto("/people");
      await requested.promise;
      if (width === 390) await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
      const rail = page.getByRole("navigation", { name: t("shell.nav") });
      await expect(rail).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const snapshot = () => rail.getByRole("link").evaluateAll(links => links.map(link => ({
        to: link.getAttribute("href"), y: link.getBoundingClientRect().y,
      })));
      const before = await snapshot();
      await page.evaluate(clearShifts);
      held.resolve();
      await expect(rail.getByRole("link", { name: t("shell.link.people"), exact: true })).toBeVisible();
      await expect(rail.getByRole("link")).toHaveCount(phase === "SETUP" ? 2 : 11);
      const after = await snapshot();
      await info.attach("rail-entries", { body: JSON.stringify({ savedPhase, phase, before, after }), contentType: "application/json" });
      expect(before, "saved entries must wait for the current answer").toEqual([]);
      expect(after.map(item => item.to)).toEqual(
        phase === "SETUP"
          ? ["/", "/people"]
          : ["/", "/people/requests", "/approvals", "/org", "/team", "/people", "/attendance", "/statutory", "/access", "/audit", "/settings"],
      );
      await expectStable(page, "current rail answer");
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `rail ${phase} ${theme}`);
        await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); }
  });
}

for (const destination of ["/", "/org", "/setup/go-live"]) {
  test(`a late in-session phase answer keeps the rail fixed on ${destination}`, async ({ page }, info) => {
    await page.addInitScript(recordShifts);
    const fixture = await mockScreen(page, screens[1], "empty");
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    let operating = false;
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/people", "SETUP"), is_ops: true } });
    await mockRoute(page, "get", "/api/v1/users/me", async () => {
      if (operating) { requested.resolve(); await held.promise; }
      return { status: 200, json: { ...user, tenant: { ...user.tenant!, phase: operating ? "OPERATING" : "SETUP" } } };
    });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: { ...checklist, phase: "SETUP", go_live_at: null, steps: [
      { key: "people", group: "people", state: "todo", action: "register_employee", skippable: false,
        counts: { entities: 1, workplaces: 1, units: 1, people: 0, unplaced: 0, entity_unknown: 0 }, paths: ["one"], can_act: true, needs: "" },
    ] } });
    await page.route("**/api/v1/onboarding/modules", route => route.fulfill({ json: [
      ...modules.ready, { key: "payroll", ready: true, unblock: null },
    ] }));
    await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", { status: 200, json: previewData("ready") });
    try {
      await go(page, "/people");
      const rail = page.getByRole("navigation", { name: t("shell.nav") });
      await expect(rail.getByRole("link", { name: t("shell.link.people"), exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      operating = true;
      // This is an in-app navigation in a fresh context; the Shell and its cached answer stay mounted.
      const navigation = go(page, destination);
      await requested.promise;
      await expect(page).toHaveURL(new RegExp(`${destination}$`));
      const snapshot = () => rail.getByRole("link").evaluateAll(links => links.map(link => ({
        to: link.getAttribute("href"), y: link.getBoundingClientRect().y,
      })));
      const before = await snapshot();
      expect(before.length).toBeGreaterThan(0);
      const answered = page.waitForResponse("**/api/v1/users/me");
      await page.evaluate(clearShifts);
      held.resolve();
      await (await answered).finished();
      await navigation;
      // Let Query observers, layout and PerformanceObserver deliver the response's frame.
      await page.waitForTimeout(600);
      const after = await snapshot();
      await info.attach("in-session-rail", { body: JSON.stringify({ destination, query: "/api/v1/users/me", before, after,
        shifts: await page.evaluate(() => window.__shifts ?? []) }), contentType: "application/json" });
      expect(after).toEqual(before);
      await expect(rail.getByRole("link", { name: t("shell.link.payroll"), exact: true })).toHaveCount(0);
      await expectStable(page, "late phase answer");
      await page.setViewportSize({ width: 390, height: 900 });
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
      await fits(page, `late phase ${destination} dark phone`);
      await page.screenshot({ path: info.outputPath("dark-phone.png"), fullPage: true });
      await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 });
      await go(page, "/people");
      await expect(rail.getByRole("link", { name: t("shell.link.payroll"), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); }
  });
}
