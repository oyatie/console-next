// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import type { Org, OpsRecoveryRead } from "../../apps/web/src/features/platform/api";
import { MAX_RETRY_AFTER_MS } from "../../apps/web/src/lib/react/query-defaults";
import { MOVES, VIEWS } from "../../apps/web/src/features/platform/domain/tenants";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { AT, failure, id, token } from "./fixtures";
import { screens } from "../states/registry";
import { experienceState } from "../experience";

test.beforeAll(() => loadCatalog("ko"));

const RECOVERY: OpsRecoveryRead = { request: null, state: null, recovery_available: false, ops_has_passkey: false,
  ops_enrolled: false, second_operator_available: true, active_accounts: 0, hold_hours: 24, code_ttl_minutes: 10 };

// The tenant search is found by its label: Classic's is a labelled text field in a search form, Console's a search field.
/** A section of the tenant record by its heading: Classic labels its sections, Console's record pane sections are unnamed. */
const section = (panel: Locator, title: string) => panel.getByRole("heading", { name: title, exact: true }).locator("xpath=ancestor::section[1]");
/** The failed read that shows `title`, with its retry. */
const failedRead = (panel: Locator, title: string) => panel.getByRole("alert").filter({ has: panel.page().getByRole("heading", { name: title, exact: true }) });
/** The headings of the record's sections, in order. */
const sectionTitles = (panel: Locator) => panel.locator("section").evaluateAll(elements => elements.map(el => el.querySelector("h2, h3")?.textContent));

async function mockPlatform(page: Page) {
  const fixture = await mockScreen(page, screens[0], "populated");
  const auth = token();
  const [header, payload, signature] = auth.access_token.split(".");
  auth.access_token = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), platform: true })).toString("base64url")}.${signature}`;
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: auth });
  // Console's filter rail reads the groups. At desk widths it opens the first tenant's record, whose reads answer here
  // unless a test holds them.
  await mockRoute(page, "get", "/api/platform/groups", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/platform/support-sessions", { status: 200, json: { sessions: [] } });
  await mockRoute(page, "get", "/api/platform/orgs/{id}/erase", { status: 200, json: { request: null, archived: false, legal_hold: false, second_operator_available: true, cooling_hours: 24 } });
  await mockRoute(page, "get", "/api/platform/orgs/{id}/ops-recovery", { status: 200, json: RECOVERY });
  return fixture;
}


for (const count of [0, 48]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const classic of [false, true]) {
  test(`tenant list settles into useful controls with ${count} customers at ${width}px ${theme}${classic ? " and status views @baseline" : ""}`, async ({ page }) => {
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
      const search = main.getByLabel(t("tenants.search"), { exact: true });
      const views = main.getByRole("group", { name: t("tenants.views"), exact: true });
      const create = main.getByRole("button", { name: t("tenants.create"), exact: true });
      await expect(search).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect.soft(create).toBeDisabled();
      if (classic) await expect.soft(views.locator(".btn__count")).toHaveText(VIEWS.map(() => ""));
      const positions = async () => Promise.all([search.boundingBox(), classic ? views.getByRole("button").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON())) : []]);
      const before = await positions();
      held.resolve();
      await expect(main.locator("#tenants-list")).toBeVisible();
      await expect(main.locator("#tenants-list tbody tr")).toHaveCount(orgs.length);
      if (count === 0) {
        await expect(search).toHaveCount(0);
        if (classic) await expect(views).toHaveCount(0);
        await expect(main.locator("#tenants-list").getByRole("button", { name: t("tenants.create"), exact: true })).toBeEnabled();
      } else {
        expect(await search.count()).toBe(1);
        expect.soft(await positions()).toEqual(before);
        if (classic) {
          expect(await views.count()).toBe(1);
          await expect(views.getByRole("button").first()).toContainText(fmtNumber(orgs.length));
        }
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

// /platform has no board, so this pins Console's render at 1440: its status views are a stat row over a filter rail. No
// board draws an admin screen at 390.
test.describe("console tenant stats", () => {
  test.use({ storageState: experienceState("console") });
  test("console tenant stats count the landed list at 1440px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await mockPlatform(page);
    const orgs: Org[] = Array.from({ length: 48 }, (_, index) => ({
      id: id(5000 + index), name: `Synthetic customer ${index + 1}`, slug: `customer-${index + 1}`,
      group_id: null, group_slug: null, group_name: null, status: "ACTIVE", created_at: AT, updated_at: AT,
    }));
    await mockRoute(page, "get", "/api/platform/orgs", { status: 200, json: orgs });
    await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
    try {
      await page.goto("/platform");
      const stats = page.getByRole("main").getByLabel(t("tenants.stat.label"), { exact: true });
      const all = stats.getByRole("button", { name: t("tenants.view.all"), exact: true });
      await expect(all).toHaveAttribute("aria-pressed", "true");
      // The stat's value stands beside its button, in the same item.
      await expect(all.locator("xpath=ancestor::div[1]")).toContainText(fmtNumber(orgs.length));
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); await page.close(); }
  });
});

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
      const search = main.getByLabel(t("tenants.search"), { exact: true });
      await expect(search).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const positions = () => search.or(main.getByRole("button", { name: t("tenants.create"), exact: true })).evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
      const before = await positions();
      held.resolve();
      await expect(main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
      expect(await positions()).toEqual(before);
      const create = main.getByRole("button", { name: t("tenants.create"), exact: true });
      await expect(create).toHaveAttribute("aria-disabled", "true");
      await expect(create).toHaveAccessibleDescription(t("tenants.create.unavailable"));
      await expect(main.getByRole("alert").getByText(t("tenants.create.unavailable"), { exact: true })).toBeVisible();
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
      await expect(main.getByLabel(t("tenants.search"), { exact: true })).toBeVisible();
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
      // Each status move once; archiving an undeletable tenant is offered as deletion's remedy instead.
      for (const move of MOVES[org.status]) await expect(panel.getByRole("button", { name: t(`tenants.status.${move}`, { org: org.name }), exact: true })).toHaveCount(1);
      const remove = panel.getByRole("button", { name: t("tenants.remove", { org: org.name }), exact: true });
      await expect(remove).toBeVisible();
      const deletion = section(panel, t("tenants.section.remove"));
      const erase = deletion.getByRole("button", { name: t("tenants.remove.force", { org: org.name }), exact: true });
      await expect(erase).toBeVisible();
      await expect(erase).toHaveAccessibleDescription(t("common.loading"));
      await expect(deletion.locator("[data-bone], [role=progressbar]")).toHaveCount(0);
      expect((await sectionTitles(panel)).at(-1)).toBe(t("tenants.section.remove"));
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
          section: el.closest("section")?.querySelector("h2, h3")?.textContent,
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
        await expect(panel.getByRole("heading", { name: t("tenants.recoveryFailed"), exact: true })).toHaveCount(Number(recoveryStatus === 503));
        await expect(deletion.getByRole("heading", { name: t("tenants.eraseFailed"), exact: true })).toHaveCount(Number(eraseStatus === 503));
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
          await failedRead(panel, t(read === "erase" ? "tenants.eraseFailed" : "tenants.recoveryFailed")).getByRole("button", { name: t("common.retry"), exact: true }).click();
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
      // The record opens on the tenant's status (Classic) or overview (Console); code, recovery and deletion close it.
      expect((await sectionTitles(panel)).slice(-3)).toEqual([t("tenants.section.code"), t("opsRecovery.title"), t("tenants.section.remove")]);
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

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const status of ["ACTIVE", "SUSPENDED", "ARCHIVED"] as const) for (const classic of [false, true]) {
  test(classic ? `tenant read reservation follows ${status} content at ${width}px ${theme} @baseline` : `tenant deletion holds still while the ${status} recovery read fails and retries at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1600 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    const fixture = await mockPlatform(page);
    const org: Org = { id: id(5000), name: "Synthetic customer", slug: "customer", group_id: null, group_slug: null, group_name: null,
      status, removable: true, created_at: AT, updated_at: AT };
    const recovery: OpsRecoveryRead = { ...RECOVERY };
    let held = Promise.withResolvers<void>();
    let failed = true;
    await mockRoute(page, "get", "/api/platform/orgs", { status: 200, json: [org] });
    await mockRoute(page, "get", "/api/platform/ops", { status: 200, json: { tenants: [], notices: [] } });
    await mockRoute(page, "get", "/api/platform/orgs/{id}/erase", { status: 200, json: {
      request: null, archived: status === "ARCHIVED", legal_hold: false, second_operator_available: true, cooling_hours: 24,
    } });
    await mockRoute(page, "get", "/api/platform/orgs/{id}/ops-recovery", async () => {
      await held.promise;
      return failed ? { status: 503, json: failure("upstream_failure"), headers: { "retry-after": String(Math.ceil(MAX_RETRY_AFTER_MS / 1000) + 1) } }
        : { status: 200, json: recovery };
    });
    try {
      const open = async () => {
        await page.goto("/platform?view=all");
        await page.getByRole("row").filter({ has: page.getByRole("gridcell", { name: org.name, exact: true }) }).click();
        await page.evaluate(() => document.fonts.ready);
      };
      await open();
      const panel = page.getByRole("complementary", { name: org.name, exact: true });
      const slot = panel.getByRole("region", { name: `${t("tenants.section.code")} · ${t("opsRecovery.title")}`, exact: true });
      const deletion = section(panel, t("tenants.section.remove"));
      const failure = failedRead(panel, t("tenants.recoveryFailed"));
      // A settled recovery read offers to open a recovery, here with the reason it cannot yet.
      const settledRecovery = panel.getByRole("button", { name: t("opsRecovery.open"), exact: true });
      const position = () => deletion.evaluate(el => el.getBoundingClientRect().top + el.closest("main")!.scrollTop + scrollY);
      const before = await position();
      held.resolve();
      await expect(failure).toBeVisible();
      expect(await position()).toBe(before);
      failed = false;
      held = Promise.withResolvers<void>();
      await failure.getByRole("button", { name: t("common.retry"), exact: true }).click();
      expect(await position()).toBe(before);
      held.resolve();
      await expect(failure).toHaveCount(0);
      await expect(settledRecovery).toBeVisible();
      expect(await position()).toBe(before);
      expect((await sectionTitles(panel)).at(-1)).toBe(t("tenants.section.remove"));
      await expect(deletion.getByRole("button", { name: t("tenants.remove", { org: org.name }), exact: true })).toBeVisible();
      if (!classic) {
        expect(fixture.unexpected).toEqual([]);
        return;
      }
      await expect(slot.locator("#tenant-ops-recovery")).toBeVisible();
      const measure = () => slot.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const last = el.querySelector("section:last-child")!;
        const contentBottom = last.getBoundingClientRect().bottom;
        return { height: rect.height, deadSpace: rect.bottom - contentBottom, overflow: getComputedStyle(el).overflowY,
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      });
      const settled = await measure();
      expect(settled.deadSpace).toBeLessThan(80);
      expect(settled.overflow).toBe("visible");
      expect(settled.scrollHeight).toBeLessThanOrEqual(settled.clientHeight + 1);
      await expect(panel.locator("section").last()).toHaveAttribute("aria-labelledby", "tenant-remove");
      await expect(deletion.getByRole("button", { name: t("tenants.remove", { org: org.name }), exact: true })).toBeVisible();
      await fits(page, `tenant-reservation/${status}/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("settled.png"), fullPage: true });
      recovery.state = "CANCELLED";
      recovery.request = { id: id(6000), target_user_id: id(6001), requested_by: id(6002), requested_by_name: "Synthetic operator",
        opened_at: AT, approved_by: null, hold_until: null, cancelled_by: id(6002), cancelled_by_name: "Synthetic operator",
        cancelled_at: AT, cancel_reason: "Synthetic cancellation evidence with enough words to exercise wrapped recovery history. ".repeat(18), issued_at: null };
      await open();
      await expect(slot.locator("#tenant-ops-recovery")).toBeVisible();
      const long = await measure();
      expect(long.height).toBeGreaterThan(settled.height);
      expect(long.deadSpace).toBeLessThan(1);
      expect(long.overflow).toBe("visible");
      expect(long.scrollHeight).toBeLessThanOrEqual(long.clientHeight + 1);
      await expect(panel.locator("section").last()).toHaveAttribute("aria-labelledby", "tenant-remove");
      await deletion.getByRole("button", { name: t("tenants.remove", { org: org.name }), exact: true }).scrollIntoViewIfNeeded();
      await expect(deletion.getByRole("button", { name: t("tenants.remove", { org: org.name }), exact: true })).toBeInViewport();
      await fits(page, `tenant-long-recovery/${status}/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("long-recovery.png"), fullPage: true });
      await test.info().attach("panel-geometry", { contentType: "application/json", body: JSON.stringify({ width, theme, status, deletionTop: before, settled, long }) });
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); await page.close(); }
  });
}
