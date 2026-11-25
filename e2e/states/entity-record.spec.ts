// SPDX-License-Identifier: LicenseRef-Proprietary
import { installFaultClock } from "./fault-clock";
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { TABS } from "../../apps/web/src/features/entity/domain/tabs";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { routeReady } from "../flows";
import { mockRoute } from "../mock/route";
import { authz, checklist, failure, id } from "../mock/fixtures";
import { entityRecordPath, entityRecordStates, mockEntityRecord } from "./entity-record";
import { clearShifts, expectStable, recordShifts } from "../stability";

test.beforeAll(() => loadCatalog("ko"));

for (const navigation of ["workplace", "list and back"] as const) test(`entity-record: ${navigation} keeps the cached record during an access refetch @ui-state`, async ({ page }) => {
  const fixture = await mockEntityRecord(page, "populated");
  const held = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  let hold = false;
  await page.route(url => url.pathname === "/api/v1/access/me", async route => {
    if (hold) { requested.resolve(); await held.promise; }
    await route.fallback();
  });
  try {
    await page.goto(entityRecordPath);
    const main = page.getByRole("main");
    const heading = main.getByRole("heading", { name: fixture.entity.current!.name!, level: 1 });
    await expect(heading).toBeVisible();
    await routeReady(page);
    if (navigation === "list and back") {
      await main.locator("header[data-band]").getByRole("link", { name: t("entity.list.title"), exact: true }).click();
      await expect(page).toHaveURL(/\/org(\?tab=entities|\/entities$)/);
      await routeReady(page);
    }
    hold = true;
    const blanks = page.evaluate(async ({ path, workplace }) => {
      let blank = 0;
      let arrived = false;
      for (let frame = 0; frame < 90; frame++) {
        const main = document.querySelector("main");
        if (location.pathname === path && (!workplace || new URLSearchParams(location.search).get("wp") === workplace)) {
          arrived = true;
          if (!main?.querySelector("h1") || main.querySelector('[data-read-layout="record"][aria-busy="true"]')) blank++;
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      return { blank, arrived };
    }, { path: entityRecordPath, workplace: navigation === "workplace" ? fixture.entity.workplaces[0]!.id : null });
    if (navigation === "workplace") {
      await main.getByRole("grid", { name: t("entityRecord.workplaces.table"), exact: true }).getByRole("row").nth(1).click();
      await expect(page).toHaveURL(url => url.searchParams.get("wp") === fixture.entity.workplaces[0]!.id);
    } else {
      await page.goBack();
      await expect(page).toHaveURL(entityRecordPath);
    }
    await requested.promise;
    expect(await blanks, "cached record must remain visible on every navigation frame").toEqual({ blank: 0, arrived: true });
    await expect(heading).toBeVisible();
    await expect(main.getByRole("tablist", { name: t("entityRecord.tabs") })).toHaveCount(1);
    held.resolve();
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});

test("entity-record: the first settings failure releases the record while its retry is pending @ui-state", async ({ page }) => {
  await installFaultClock(page);
  const fixture = await mockEntityRecord(page, "populated");
  const held = Promise.withResolvers<void>();
  const retry = Promise.withResolvers<void>();
  let requests = 0;
  await mockRoute(page, "get", "/api/v1/settings", async () => {
    if (++requests > 1) { retry.resolve(); await held.promise; }
    return { status: 503, json: failure("service_unavailable") };
  });
  try {
    await page.goto(entityRecordPath);
    await retry.promise;
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: fixture.entity.current!.name!, level: 1 })).toBeVisible();
    await expect(main.locator('[data-read-layout="record"][aria-busy="true"]')).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});

test("entity-record: a refusal is shown while the checklist is still pending @ui-state", async ({ page }) => {
  const fixture = await mockEntityRecord(page, "refused");
  const held = Promise.withResolvers<void>();
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    await held.promise;
    return { status: 200, json: checklist };
  });
  try {
    await page.goto(entityRecordPath);
    const main = page.getByRole("main");
    await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
    await expect(main.locator('[data-read-layout="record"][aria-busy="true"]')).toHaveCount(0);
    await expect(main.getByRole("tablist")).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});

for (const state of entityRecordStates) for (const width of state === "long" ? [1440, 390, 320] : [1440, 390]) {
  test(`entity-record: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await mockEntityRecord(page, state);
    try {
      await page.goto(entityRecordPath);
      const main = page.getByRole("main");
      if (state === "loading") {
        await expect(main.locator('[data-read-layout="record"]')).toBeVisible();
      } else if (state === "failed") {
        await expect(main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toHaveCount(1);
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeEnabled();
        await expect(main.getByText(fixture.operationId, { exact: true })).toBeVisible();
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
      } else if (state === "missing") {
        await expect(main.getByRole("heading", { name: t("common.read.notFound.title") })).toBeVisible();
        await expect(main.getByRole("link", { name: t("denied.entity.back"), exact: true })).toHaveAttribute("href", "/org/entities");
      } else {
        const head = main.locator("header[data-band]");
        await expect(head.getByRole("heading", { level: 1 })).toHaveText(fixture.entity.current!.name);
        await expect(head.getByRole("link", { name: t("entity.list.title"), exact: true })).toHaveAttribute("href", "/org/entities");
        const tabs = main.getByRole("tablist", { name: t("entityRecord.tabs") });
        await expect(tabs).toHaveCount(1);
        await expect(tabs.getByRole("tab")).toHaveCount(6);
        await expect(tabs.getByRole("tab", { selected: true })).toHaveText(t("entityRecord.tab.overview"));
        const workplaces = main.getByRole("grid", { name: t("entityRecord.workplaces.table") });
        if (width <= 390) {
          await expect(workplaces.locator('[data-card="title"]')).toContainText(fixture.entity.workplaces[0]!.current!.name);
          await expect(workplaces.locator('[data-card="fact"]').filter({ hasText: fixture.entity.registrations[0]!.brn!.display })).toBeVisible();
        }
        const officers = tabs.getByRole("tab", { name: /^임원\s+2$/ });
        await officers.click();
        const panel = main.getByRole("tabpanel");
        await expect(panel.getByRole("listitem")).toHaveCount(2);
        await expect(panel).toContainText("김대표");
        await expect(panel).toContainText("이대표");
        await expect(panel.getByRole("region", { name: t("entityRecord.field.directors"), exact: true }).getByText(t("entityRecord.officers.none"))).toBeVisible();
        await officers.press("Home");
        await expect(tabs.getByRole("tab", { selected: true })).toHaveText(t("entityRecord.tab.overview"));
        await tabs.getByRole("tab", { selected: true }).press("ArrowRight");
        await expect(tabs.getByRole("tab", { selected: true })).toHaveText(/^사업자등록증\s*1$/);
        await tabs.getByRole("tab", { selected: true }).press("End");
        await expect(tabs.getByRole("tab", { selected: true })).toHaveText(/^이력\s*0$/);
        await expect(tabs.getByRole("tab", { name: /^문서/ })).toHaveText(/^문서\s*0$/);
        await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
        await tabs.getByRole("tab", { selected: true }).press("Home");
      }
      // shortcut: check record containment at 320px until SHELL-IA fixes the shell's overflowing logout button.
      if (width === 320) expect(await main.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      else await fits(page, `entity-record/${state}/${width}`);
      await expectAxe(page, `entity-record/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected, "register every supporting read").toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}

for (const tab of TABS) test(`the ${tab} deep link selects its tab @ui-state`, async ({ page }) => {
  const fixture = await mockEntityRecord(page, "populated");
  try {
    await page.goto(`${entityRecordPath}?tab=${tab}`);
    await expect(page.getByRole("tab", { selected: true })).toContainText(t(`entityRecord.tab.${tab}`));
    await expect(page.getByRole("tabpanel")).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("tab selection replaces the URL, preserves the read point and survives reload @ui-state", async ({ page }) => {
  const fixture = await mockEntityRecord(page, "populated");
  try {
    await page.goto(`${entityRecordPath}?as_of=2026-01-01`);
    const historyLength = await page.evaluate(() => history.length);
    for (const tab of [...TABS.slice(1), TABS[0]]) {
      const control = page.getByRole("tab", { name: new RegExp(`^${t(`entityRecord.tab.${tab}`)}(?:\\s|$)`) });
      await control.click();
      await expect(page).toHaveURL(url => url.searchParams.get("tab") === tab && url.searchParams.get("as_of") === "2026-01-01");
      await expect(control).toBeFocused();
      await expect(control).toHaveAttribute("aria-selected", "true");
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      await page.reload();
      await expect(page.getByRole("tab", { selected: true })).toContainText(t(`entityRecord.tab.${tab}`));
    }
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("late document and history counts preserve the tab positions @ui-state", async ({ page }) => {
  const fixture = await mockEntityRecord(page, "populated");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/documents", async () => {
    await held;
    return { status: 200, json: { items: Array.from({ length: 2 }, (_, n) => ({
      id: id(4110 + n), kind: "OTHER" as const, file_name: `record-${n}.pdf`, content_type: "application/pdf" as const,
      byte_size: 100, uploaded_at: "2026-01-01T00:00:00Z", retention_key: "retention.entity_registration_document" as const, extraction_status: "NONE" as const,
    })) } };
  });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/revisions", async () => {
    await held;
    return { status: 200, json: { items: Array.from({ length: 3 }, (_, n) => ({
      version: n + 1, effective_from: "2026-01-01", recorded_at: "2026-01-01T00:00:00Z", change_mode: "SETUP" as const, changes: [],
    })) } };
  });
  try {
    await page.goto(entityRecordPath);
    const tabs = page.getByRole("tablist", { name: t("entityRecord.tabs") });
    const history = tabs.getByRole("tab", { name: /^이력/ });
    const documents = tabs.getByRole("tab", { name: /^문서/ });
    await expect(history).toBeVisible();
    await expect(documents).toHaveText(t("entityRecord.tab.documents"));
    await expect(history).toHaveText(t("entityRecord.tab.history"));
    await page.evaluate(() => document.fonts.ready);
    const before = [await documents.boundingBox(), await history.boundingBox()];
    release();
    await expect(documents).toHaveText(/^문서\s*2$/);
    await expect(history).toHaveText(/^이력\s*3$/);
    expect([await documents.boundingBox(), await history.boundingBox()]).toEqual(before);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    release();
    fixture.release();
  }
});

/** An org-wide entity manager also gets the identifier-correction register under the tabs; `read` settles once it has read. */
async function mockRegister(page: Page, entityId: string) {
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities,
    { feature: "legal_entity_manage", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }] } });
  const correction: components["schemas"]["IdentifierCorrectionCase"] = {
    id: id(4190), entity_id: entityId, entity_name: "Synthetic Entity", subject_id: entityId, subject_type: "LEGAL_ENTITY",
    status: "PENDING", requested_by: id(1), payload_hash: "a".repeat(64), proposal: null, expires_at: "2026-12-01T00:00:00Z",
    created_at: "2026-11-01T00:00:00Z", review_due_at: null, reviewed_at: null, consumed_at: null, can_apply: false,
  };
  await mockRoute(page, "get", "/api/v1/entity-identifier-corrections", { status: 200, json: { items: [correction], next_offset: 20 } });
  return { read: page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/entity-identifier-corrections") };
}
const revisions = (n: number) => ({ status: 200 as const, json: { items: Array.from({ length: n }, (_, k) => ({
  version: k + 1, effective_from: "2026-01-01", recorded_at: "2026-01-01T00:00:00Z", change_mode: "SETUP" as const, changes: [],
})) } });
const registerNext = (page: Page) => page.getByRole("region", { name: t("entityRecord.corrections.title"), exact: true })
  .getByRole("button", { name: t("entityRecord.corrections.next"), exact: true });
const historyRegion = (page: Page) => page.getByRole("region", { name: t("entity.history.title"), exact: true });

for (const experience of ["baseline", "console"] as const) test(`arriving on the history tab draws its revisions and the correction register under them at once in ${experience} @ui-state${experience === "baseline" ? " @baseline" : ""}`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(recordShifts);
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [EXPERIENCE_KEY, experience] as const);
  const fixture = await mockEntityRecord(page, "populated");
  const { read: corrections } = await mockRegister(page, fixture.entity.id);
  const held = Promise.withResolvers<void>();
  const requested = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/revisions"));
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/revisions", async () => { await held.promise; return revisions(6); });
  await mockRoute(page, "get", "/api/v1/business-registrations/{registrationId}/revisions", async () => { await held.promise; return revisions(2); });
  try {
    await page.goto(`${entityRecordPath}?tab=history`);
    await Promise.all([requested, corrections]);
    await expect(page.getByRole("tablist", { name: t("entityRecord.tabs") })).toBeVisible();
    expect(await page.locator("html").getAttribute("data-experience") ?? "baseline").toBe(experience);
    // The register reads beside the history but shows with it: drawn first, the revisions pushed it down the page.
    expect.soft(await registerNext(page).isVisible(), "the correction register waits for the history tab's first answers").toBe(false);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(clearShifts);
    held.resolve();
    await expect(historyRegion(page).getByRole("listitem").first()).toBeVisible();
    await expect(registerNext(page)).toBeVisible();
    await expectStable(page, `history tab arrival in ${experience}`);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
    await page.close();
    fixture.release();
  }
});

test("asking a failed certificate history again keeps the drawn revisions and the correction register in place @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await mockEntityRecord(page, "populated");
  const { read: corrections } = await mockRegister(page, fixture.entity.id);
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/revisions", revisions(6));
  const held = Promise.withResolvers<void>();
  let asked = 0;
  await mockRoute(page, "get", "/api/v1/business-registrations/{registrationId}/revisions", async () => {
    if (asked++ === 0) return { status: 503, json: failure("service_unavailable") };
    await held.promise;
    return revisions(2);
  });
  try {
    await page.goto(`${entityRecordPath}?tab=history`);
    await corrections;
    const revision = historyRegion(page).getByRole("listitem").first();
    const retry = historyRegion(page).getByRole("button", { name: t("common.retry"), exact: true });
    await expect(revision).toBeVisible();
    await expect(registerNext(page)).toBeVisible();
    await retry.click();
    // The re-ask has reached the screen once the failure, and its button, gives way.
    await expect(retry).toHaveCount(0);
    // Only the failed certificate's section waits on its answer: what the tab already drew, and the register, stay.
    await expect(revision).toBeVisible();
    await expect(registerNext(page)).toBeVisible();
    held.resolve();
    const certificate = historyRegion(page).getByRole("region", { name: t("entity.history.registration", { name: fixture.entity.registrations[0]!.brn!.display }), exact: true });
    await expect(certificate.getByRole("listitem")).toHaveCount(2);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
    await page.close();
    fixture.release();
  }
});

test("the correction register shows at once on the overview tab while the history is still on its way @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await mockEntityRecord(page, "populated");
  const { read: corrections } = await mockRegister(page, fixture.entity.id);
  const held = Promise.withResolvers<void>();
  const requested = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/revisions"));
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/revisions", async () => { await held.promise; return revisions(6); });
  try {
    await page.goto(entityRecordPath);
    await Promise.all([requested, corrections]);
    // The register waits only for the history tab's sections, not the overview aside's read of the same history.
    await expect(registerNext(page)).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    held.resolve();
    await page.close();
    fixture.release();
  }
});

for (const read of ["checklist", "settings"]) for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
  test(`entity-record: late receipt ${read} settles through the shared phase at ${width}px ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockEntityRecord(page, "populated");
    const held = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
      if (read === "checklist") await held.promise;
      return { status: 200, json: { ...checklist, go_live_at: new Date().toISOString() } };
    });
    await mockRoute(page, "get", "/api/v1/settings", async () => {
      if (read === "settings") await held.promise;
      return { status: 200, json: { can_change: false, items: [{
        key: "onboarding.receipt_days", value: 2, default: 2, kind: { type: "int" as const, unit: "days" as const },
        looser_when: "neutral" as const, governance: "tenant" as const, legal_basis: null, version: "code_default" as const, effective_from: null, scheduled: [],
        source: { layer: "code_default" as const, scope_entity_id: null }, chain: [],
      }] } };
    });
    try {
      const entityRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/legal-entities/${fixture.entity.id}`);
      await page.goto(entityRecordPath);
      await (await entityRead).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const main = page.getByRole("main");
      if (read === "checklist") {
        await expect(main.getByRole("status", { name: t("common.loading"), exact: true })).toHaveAttribute("aria-busy", "true");
        await expect(main.locator("[data-phase-pending]")).toHaveAttribute("inert", "");
        await expect(main.getByRole("tablist")).toHaveCount(0);
      } else {
        await expect(main.getByRole("heading", { name: fixture.entity.current!.name!, level: 1 })).toBeVisible();
      }
      await fits(page, `entity-record/pending-receipt/${width}/${theme}`);
      held.resolve();
      await expect(main.getByRole("heading", { name: fixture.entity.current!.name!, level: 1 })).toBeVisible();
      await expect(main.locator('[data-phase-band="started"]')).toHaveCount(1);
      await expect(main.getByRole("tablist", { name: t("entityRecord.tabs") })).toHaveCount(1);
      await fits(page, `entity-record/receipt/${width}/${theme}`);
      await expectAxe(page, `entity-record/receipt/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("entity-record-receipt.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); await page.close(); fixture.release(); }
  });
}
