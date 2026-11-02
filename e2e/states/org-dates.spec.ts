// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { id } from "../mock/fixtures";
import { orgPanelReads } from "../mock/org-work";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) {
  test(`org: compact date picker navigates change dates and returns to today (${width}px) @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-11-02T12:00:00+09:00"));
    const fixture = await mockScreen(page, screens[2], "populated");
    await mockRoute(page, "get", "/api/v1/org-structure/change-dates", { status: 200, json: { items: ["2026-10-01", "2026-11-02", "2026-12-01"] } });
    try {
      await page.goto("/org");
      const control = page.getByRole("region", { name: t("asof.label"), exact: true });
      const trigger = control.getByRole("button", { name: new RegExp(`^${t("asof.label")} · `) });
      await expect(trigger).toContainText(fmtDate("2026-11-02"));
      await expect(control.getByRole("textbox")).toHaveCount(0);
      await expect(page.getByRole("button", { name: t("asof.advanced"), exact: true })).toHaveCount(0);
      await trigger.click();
      const picker = page.getByRole("dialog", { name: t("asof.label"), exact: true });
      await expect(picker).toBeVisible();
      await expect(picker.getByRole("group", { name: t("asof.ribbon"), exact: true }).getByRole("button")).toHaveCount(3);
      await picker.getByRole("button", { name: t("asof.previous"), exact: true }).click();
      await expect(page).toHaveURL(/as_of=2026-10-01/);
      await expect(trigger).toContainText(fmtDate("2026-10-01"));
      await trigger.click();
      await picker.getByRole("button", { name: t("uiDate.calendar.open"), exact: true }).click();
      const calendar = page.getByRole("dialog", { name: t("uiDate.calendar.label"), exact: true });
      await expect(calendar.getByRole("grid")).toBeVisible();
      const bounds = await calendar.boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(360);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `org date/${width}/${theme}`);
        await expectAxe(page, `org date/${width}/${theme}`);
      }
      await page.keyboard.press("Escape");
      await expect(calendar).toHaveCount(0);
      const input = picker.getByRole("textbox", { name: t("asof.label"), exact: true });
      await input.fill("20260230");
      await input.press("Tab");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(page).toHaveURL(/as_of=2026-10-01/);
      await input.fill("20261201");
      await input.press("Enter");
      await expect(page).toHaveURL(/as_of=2026-12-01/);
      await expect(picker).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await control.getByRole("button", { name: t("asof.returnToday"), exact: true }).click();
      await expect(page).not.toHaveURL(/as_of=/);
      await expect(trigger).toContainText(fmtDate("2026-11-02"));
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("org: exact knowledge links stay visible without offering a knowledge-date editor @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  const knownAt = "2026-09-15T12:34:56+09:00";
  try {
    await page.goto(`/org?as_of=2026-09-01&known_at=${encodeURIComponent(knownAt)}`);
    const control = page.getByRole("region", { name: t("asof.label"), exact: true });
    await expect(control).toContainText(fmtDateTime(knownAt));
    await control.getByRole("button", { name: new RegExp(`^${t("asof.label")} · `) }).click();
    const picker = page.getByRole("dialog", { name: t("asof.label"), exact: true });
    await expect(picker.getByRole("textbox")).toHaveCount(1);
    await expect(page.getByRole("button", { name: t("asof.advanced"), exact: true })).toHaveCount(0);
    await picker.getByRole("textbox").fill("20260902");
    await picker.getByRole("textbox").press("Enter");
    await expect(page).toHaveURL(/as_of=2026-09-02/);
    expect(new URL(page.url()).searchParams.get("known_at")).toBe(knownAt);
    await control.getByRole("button", { name: t("asof.returnToday"), exact: true }).click();
    await expect(page).not.toHaveURL(/known_at=/);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("org: empty date fields use a Korean placeholder and presets show one resolved date @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  try {
    await page.goto("/_gallery?entry=date");
    await expect(page.getByRole("textbox").first()).toHaveAttribute("placeholder", "연도. 월. 일.");
    await orgPanelReads(page);
    await page.goto(`/org?act=dept-add&sel=${id(4)}`);
    const presets = page.getByRole("group", { name: t("uiDate.presets", { label: t("orgUnit.gov.date") }), exact: true });
    await expect(presets).toBeVisible();
    expect(await presets.innerText()).not.toMatch(/\d{4}\. \d{2}\. \d{2}\.\).*\d{4}\./);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
