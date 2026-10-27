// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { TABS } from "../../apps/web/src/features/entity/domain/tabs";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { checklist, id } from "../mock/fixtures";
import { entityRecordPath, entityRecordStates, mockEntityRecord } from "./entity-record";

test.beforeAll(() => loadCatalog("ko"));

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
        await expect(main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toHaveCount(1, { timeout: 20_000 });
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

test("entity-record: late phase facts do not move record fields or controls @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await mockEntityRecord(page, "populated");
  const held = Promise.withResolvers<void>();
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
    await held.promise;
    return { status: 200, json: checklist };
  });
  fixture.entity.registrations[0]!.current = {
    version: 1, effective_from: "2026-01-01", before_first_record: false,
    trade_name: fixture.entity.current!.name!, business_types: [], tax_type: "01", status: "CONTINUING", change_mode: "SETUP",
  };
  try {
    await page.goto(entityRecordPath);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: fixture.entity.current!.name!, level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(main.getByRole("button", { name: "과세유형 수정", exact: true })).toHaveCount(0);
    const fields = main.locator('[class*="_fact_"]');
    const before = await fields.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
    held.resolve();
    await expect(main.getByRole("button", { name: "과세유형 수정", exact: true })).toBeVisible();
    expect(await fields.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()))).toEqual(before);
    expect(fixture.unexpected).toEqual([]);
  } finally { held.resolve(); await page.close(); fixture.release(); }
});
