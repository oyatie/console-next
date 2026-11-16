// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import type { Org } from "../../apps/web/src/features/platform/api";
import { MAX_RETRY_AFTER_MS } from "../../apps/web/src/lib/react/query-defaults";
import { VIEWS } from "../../apps/web/src/features/platform/domain/tenants";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { AT, failure, id, token } from "./fixtures";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

async function mockPlatform(page: Page) {
  const fixture = await mockScreen(page, screens[0], "populated");
  const auth = token();
  const [header, payload, signature] = auth.access_token.split(".");
  auth.access_token = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), platform: true })).toString("base64url")}.${signature}`;
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: auth });
  return fixture;
}


for (const count of [0, 48]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`tenant list settles into useful controls with ${count} customers at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    const fixture = await mockPlatform(page);
    const held = Promise.withResolvers<void>();
    const orgs: Org[] = Array.from({ length: count }, (_, index) => ({
      id: id(5000 + index), name: `Synthetic customer ${index + 1}`, slug: `customer-${index + 1}`,
      group_id: null, group_slug: null, group_name: null, status: "ACTIVE", created_at: AT, updated_at: AT,
    }));
    await mockRoute(page, "get", "/api/platform/orgs", async () => {
      await held.promise;
      return { status: 200, json: orgs };
    });
    await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
    try {
      await page.goto("/platform");
      const main = page.getByRole("main");
      const search = main.getByRole("search");
      const views = main.getByRole("group", { name: t("tenants.views"), exact: true });
      const create = main.getByRole("button", { name: t("tenants.create"), exact: true });
      await expect(search).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect.soft(create).toBeDisabled();
      await expect.soft(views.locator(".btn__count")).toHaveText(VIEWS.map(() => ""));
      const positions = async () => Promise.all([search.boundingBox(), views.getByRole("button").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))]);
      const before = await positions();
      held.resolve();
      await expect(main.locator("#tenants-list")).toBeVisible();
      await expect(main.locator("#tenants-list tbody tr")).toHaveCount(orgs.length);
      if (count === 0) {
        await expect(search).toHaveCount(0);
        await expect(views).toHaveCount(0);
        await expect(main.locator("#tenants-list").getByRole("button", { name: t("tenants.create"), exact: true })).toBeEnabled();
      } else {
        expect(await search.count()).toBe(1);
        expect(await views.count()).toBe(1);
        expect.soft(await positions()).toEqual(before);
        await expect(views.getByRole("button").first()).toContainText(fmtNumber(orgs.length));
      }
      await expect(create).toBeEnabled();
      await expect(create).toHaveCount(1);
      await fits(page, `tenant-list/${width}/${theme}`);
      await expectAxe(page, `tenant-list/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("tenant-list.png"), fullPage: true });
      if (count === 0) {
        await create.click();
        await expect(page.getByRole("dialog", { name: t("tenants.create"), exact: true })).toBeVisible();
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); await page.close(); }
  });
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`tenant creation explains a failed list and recovers to an empty-card action at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    const fixture = await mockPlatform(page);
    const held = Promise.withResolvers<void>();
    let failed = true;
    await mockRoute(page, "get", "/api/platform/orgs", async () => {
      await held.promise;
      return failed
      ? { status: 503, json: failure("upstream_failure"), headers: { "retry-after": String(Math.ceil(MAX_RETRY_AFTER_MS / 1000) + 1) } }
      : { status: 200, json: [] };
    });
    await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
    try {
      await page.goto("/platform");
      const main = page.getByRole("main");
      await expect(main.getByRole("search")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const positions = () => main.locator(".page__head button, .page__head input").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
      const before = await positions();
      held.resolve();
      await expect(main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
      expect(await positions()).toEqual(before);
      const create = main.getByRole("button", { name: t("tenants.create"), exact: true });
      await expect(create).toHaveAttribute("aria-disabled", "true");
      await expect(create).toHaveAccessibleDescription(t("tenants.create.unavailable"));
      await expect(main.getByRole("alert").locator(".state__actions").getByText(t("tenants.create.unavailable"), { exact: true })).toBeVisible();
      await create.focus();
      await create.press("Enter");
      await create.click({ force: true });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await fits(page, `tenant-failure/${width}/${theme}`);
      await expectAxe(page, `tenant-failure/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("tenant-failure.png"), fullPage: true });
      failed = false;
      await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
      await expect(main.getByRole("heading", { name: t("tenants.empty.title"), exact: true })).toBeVisible();
      await expect(create).toHaveCount(1);
      await main.locator("#tenants-list").getByRole("button", { name: t("tenants.create"), exact: true }).click();
      await expect(page.getByRole("dialog", { name: t("tenants.create"), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); await page.close(); }
  });
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`offline first tenant read describes its unavailable create action at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    const fixture = await mockPlatform(page);
    const held = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/platform/orgs", async () => { await held.promise; return { status: 200, json: [] }; });
    await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
    try {
      await page.goto("/platform");
      const main = page.getByRole("main");
      await expect(main.getByRole("search")).toBeVisible();
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        dispatchEvent(new Event("offline"));
      });
      await expect(main.getByRole("heading", { name: t("common.read.offline"), exact: true })).toBeVisible();
      const create = main.getByRole("button", { name: t("tenants.create"), exact: true });
      await expect(create).toHaveCount(1);
      await expect(create).toHaveAttribute("aria-disabled", "true");
      await expect(create).toHaveAccessibleDescription(t("tenants.create.unavailable"));
      await create.focus();
      await create.press("Enter");
      await create.click({ force: true });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await fits(page, `tenant-offline/${width}/${theme}`);
      await expectAxe(page, `tenant-offline/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("tenant-offline.png"), fullPage: true });
      await page.evaluate(() => {
        Reflect.deleteProperty(navigator, "onLine");
        dispatchEvent(new Event("online"));
      });
      held.resolve();
      await expect(main.getByRole("heading", { name: t("tenants.empty.title"), exact: true })).toBeVisible();
      await expect(create).not.toHaveAttribute("aria-disabled", "true");
      await create.click();
      await expect(page.getByRole("dialog", { name: t("tenants.create"), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); await page.close(); }
  });

  test(`cached tenant rows keep creation available offline at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    const fixture = await mockPlatform(page);
    const org: Org = { id: id(5000), name: "Synthetic customer", slug: "customer", group_id: null, group_slug: null, group_name: null,
      status: "ACTIVE", created_at: AT, updated_at: AT };
    await mockRoute(page, "get", "/api/platform/orgs", { status: 200, json: [org] });
    await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
    try {
      await page.goto("/platform");
      const main = page.getByRole("main");
      const row = main.getByRole("row").filter({ has: page.getByRole("gridcell", { name: org.name, exact: true }) });
      await expect(row).toBeVisible();
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        dispatchEvent(new Event("offline"));
      });
      await expect(main.getByText(t("common.read.offline"), { exact: true })).toBeVisible();
      await expect(row).toBeVisible();
      const create = main.getByRole("button", { name: t("tenants.create"), exact: true });
      await expect(create).toHaveCount(1);
      await expect(create).toBeEnabled();
      await expect(create).not.toHaveAttribute("aria-disabled", "true");
      await expect(create).toHaveAccessibleDescription("");
      await fits(page, `tenant-cached-offline/${width}/${theme}`);
      await expectAxe(page, `tenant-cached-offline/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("tenant-cached-offline.png"), fullPage: true });
      await create.click();
      await expect(page.getByRole("dialog", { name: t("tenants.create"), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); await page.close(); }
  });

  for (const removable of [true, false]) for (const first of ["recovery", "erase"] as const) for (const recoveryStatus of [200, 503]) for (const eraseStatus of [200, 503]) {
  test(`tenant panel buttons stay still with removable ${removable} when ${first} settles first with recovery ${recoveryStatus} and erase ${eraseStatus} at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1600 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    const fixture = await mockPlatform(page);
    const org: Org = { id: id(5000), name: "Synthetic customer", slug: "customer", group_id: null, group_slug: null, group_name: null,
      status: "ACTIVE", removable, removal_refusal: removable ? null : "tenant_has_data", created_at: AT, updated_at: AT };
    const held = { recovery: Promise.withResolvers<void>(), erase: Promise.withResolvers<void>() };
    const statuses = { recovery: recoveryStatus, erase: eraseStatus };
    await mockRoute(page, "get", "/api/platform/orgs", { status: 200, json: [org] });
    await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
    const failed = { status: 503 as const, json: failure("upstream_failure"), headers: { "retry-after": String(Math.ceil(MAX_RETRY_AFTER_MS / 1000) + 1) } };
    await mockRoute(page, "get", "/api/platform/orgs/{id}/erase", async () => {
      await held.erase.promise;
      return statuses.erase === 503 ? failed : { status: 200, json: { request: null, archived: false, legal_hold: false, second_operator_available: true, cooling_hours: 24 } };
    });
    await mockRoute(page, "get", "/api/platform/orgs/{id}/ops-recovery", async () => {
      await held.recovery.promise;
      return statuses.recovery === 503 ? failed
        : { status: 200, json: { request: null, state: null, recovery_available: false, ops_has_passkey: false, ops_enrolled: false, second_operator_available: true, active_accounts: 0, hold_hours: 24, code_ttl_minutes: 10 } };
    });
    try {
      await page.goto("/platform");
      await page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: org.name, exact: true }) }).click();
      const panel = page.getByRole("complementary", { name: org.name, exact: true });
      await expect(panel.locator('section[aria-labelledby="tenant-status"] button')).toHaveCount(removable ? 2 : 1);
      const remove = panel.getByRole("button", { name: t("tenants.remove", { org: org.name }), exact: true });
      await expect(remove).toBeVisible();
      const deletion = panel.getByRole("region", { name: t("tenants.section.remove"), exact: true });
      const erase = deletion.getByRole("button", { name: t("tenants.remove.force", { org: org.name }), exact: true });
      await expect(erase).toBeVisible();
      await expect(erase).toHaveAccessibleDescription(t("common.loading"));
      await expect(panel.locator("section").last()).toHaveAttribute("aria-labelledby", "tenant-remove");
      if (removable) await expect(remove).toBeEnabled();
      else {
        await expect(remove).toHaveAttribute("aria-disabled", "true");
        await expect(remove).toHaveAccessibleDescription(t("tenants.remove.hasData", { org: org.name }));
        await expect(panel.getByRole("button", { name: t("tenants.status.archive", { org: org.name }), exact: true })).toHaveCount(1);
      }
      await page.evaluate(() => document.fonts.ready);
      // Retry clicks can scroll the shell; scroll-container coordinates distinguish that from layout movement.
      const positions = () => panel.getByRole("button").evaluateAll(elements => elements.map(el => {
        const rect = el.getBoundingClientRect();
        const main = el.closest("main")!;
        rect.x += scrollX + main.scrollLeft;
        rect.y += scrollY + main.scrollTop;
        return {
          name: el.getAttribute("aria-label") ?? el.textContent,
          section: el.closest("section[aria-labelledby]")?.getAttribute("aria-labelledby"),
          failure: el.closest('[role="alert"]') !== null,
          rect: rect.toJSON(),
        };
      }));
      let before = await positions();
      for (const read of [first, first === "recovery" ? "erase" : "recovery"] as const) {
        const received = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(read === "erase" ? "/erase" : "/ops-recovery"));
        held[read].resolve();
        await (await received).finished();
        // Wait for React to commit the response before measuring any mounted button again.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const after = await positions();
        for (const button of before) expect.soft(after.find(next => next.name === button.name && next.section === button.section)).toEqual(button);
        before = after;
      }
      if (recoveryStatus === 503 || eraseStatus === 503) {
        const failures = Number(recoveryStatus === 503) + Number(eraseStatus === 503);
        await expect(panel.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toHaveCount(failures);
        await expect(panel.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(failures);
        await expect(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toHaveCount(recoveryStatus === 503 ? 0 : 1);
        await expect(erase).toBeVisible();
        if (eraseStatus === 503) {
          await expect(erase).toHaveAttribute("aria-disabled", "true");
          await expect(erase).toHaveAccessibleDescription(t("common.loadFailed.title"));
        }
        held.recovery = Promise.withResolvers<void>();
        held.erase = Promise.withResolvers<void>();
        statuses.recovery = statuses.erase = 200;
        for (const read of [first, first === "recovery" ? "erase" : "recovery"] as const) {
          if (read === "recovery" ? recoveryStatus !== 503 : eraseStatus !== 503) continue;
          const received = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(read === "erase" ? "/erase" : "/ops-recovery"));
          const resource = read === "erase" ? deletion : panel.getByRole("region", { name: `${t("tenants.section.code")} · ${t("opsRecovery.title")}`, exact: true });
          await resource.getByRole("button", { name: t("common.retry"), exact: true }).click();
          // The retry can scroll into view; measure the held response after that deliberate movement.
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const persistent = (await positions()).filter(button => !button.failure);
          held[read].resolve();
          await (await received).finished();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const after = await positions();
          for (const button of persistent) expect.soft(after.find(next => next.name === button.name && next.section === button.section)).toEqual(button);
        }
      }
      await expect(panel.getByRole("heading", { name: t("opsRecovery.title"), exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: t("tenants.reissue"), exact: true })).toBeEnabled();
      await expect(panel.getByRole("button", { name: t("tenants.remove.force", { org: org.name }), exact: true })).toHaveCount(1);
      const sections = await panel.locator("section[aria-labelledby]").evaluateAll(elements => elements.map(el => el.getAttribute("aria-labelledby")));
      expect(sections).toEqual(["tenant-status", "tenant-code", "tenant-ops-recovery", "tenant-remove"]);
      await expect(erase).toHaveCount(1);
      await expect(erase).toHaveAccessibleDescription(t("tenants.erase.tenant_active"));
      await fits(page, `tenant-panel/${width}/${theme}`);
      await expectAxe(page, `tenant-panel/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("tenant-panel.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { held.recovery.resolve(); held.erase.resolve(); fixture.release(); await page.close(); }
  });
  }
}
