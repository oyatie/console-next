// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

// The dev server serves the source module; the prebuilt suite serves the hashed chunk.
const calendarChunk = (url: URL) => /\/ui\/date\/date-calendar\.tsx$|\/assets\/date-calendar-[^/]+\.js$/.test(url.pathname);

test.beforeAll(() => loadCatalog("ko"));

for (const intent of ["hover", "focus"] as const) {
  test(`date calendar loads on ${intent}; typing works while its chunk is held`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[1], "empty");
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(calendarChunk, async route => {
      requests++;
      await held;
      await route.continue();
    });
    try {
      await page.goto("/_gallery");
      const demo = page.locator("section").filter({ has: page.getByRole("heading", { name: "날짜 필드", exact: true }) });
      const input = demo.getByRole("textbox").first();
      const trigger = demo.getByRole("button", { name: t("uiDate.calendar.open"), exact: true }).first();
      await expect(input).toBeVisible();
      expect(requests).toBe(0);
      await trigger[intent]();
      await expect.poll(() => requests).toBe(1);
      const calendar = page.getByRole("dialog", { name: t("uiDate.calendar.label"), exact: true });
      await expect(calendar).toHaveCount(0);
      await input.fill("20261115");
      await input.press("Tab");
      await expect(input).toHaveValue("2026. 11. 15.");
      await trigger.press("Enter");
      await expect(calendar).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(calendar).toHaveCount(0);
      const delivered = page.waitForResponse(response => calendarChunk(new URL(response.url())));
      release();
      await delivered;
      await expect(calendar).toHaveCount(0);
      await trigger.press("Enter");
      await expect(calendar).toBeVisible();
      await expect(calendar.getByRole("button", { name: /2026년 11월 15일/ })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect(calendar).toHaveCount(0);
      await expect(input).toHaveValue("2026. 11. 16.");
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      await expect(calendar).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(calendar).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(requests).toBe(1);
    } finally {
      release();
      fixture.release();
      await page.close();
    }
  });
}

for (const intent of ["hover", "focus"] as const) {
  test(`failed calendar ${intent} prefetch stays handled and its error leaves the form editable`, async ({ page }) => {
    const fixture = await mockScreen(page, screens[1], "empty");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(calendarChunk, route => route.fulfill({
      contentType: "text/javascript", body: 'globalThis.calendarAttempted = true; throw new Error("calendar load failed");',
    }));
    try {
      await page.goto("/_gallery");
      const demo = page.locator("section").filter({ has: page.getByRole("heading", { name: "날짜 필드", exact: true }) });
      const input = demo.getByRole("textbox").first();
      const trigger = demo.getByRole("button", { name: t("uiDate.calendar.open"), exact: true }).first();
      await input.fill("20261115");
      await trigger[intent]();
      await page.waitForFunction(() => (globalThis as { calendarAttempted?: boolean }).calendarAttempted);
      await input.focus();
      await input.press("Tab");
      expect(errors).toEqual([]);
      await trigger.press("Enter");
      const calendar = page.getByRole("dialog", { name: t("uiDate.calendar.label"), exact: true });
      await expect(calendar.getByRole("alert")).toContainText("날짜를 직접 입력");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(input).toHaveValue("2026. 11. 15.");
      await input.fill("20261117");
      await input.press("Tab");
      await expect(input).toHaveValue("2026. 11. 17.");
      expect(errors).toEqual([]);
    } finally {
      fixture.release();
      await page.close();
    }
  });
}

test("a missing calendar chunk shows a local error without reloading the draft", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "empty");
  let attempts = 0;
  await page.route(calendarChunk, route => { attempts++; return route.abort(); });
  try {
    await page.goto("/_gallery");
    const demo = page.locator("section").filter({ has: page.getByRole("heading", { name: "날짜 필드", exact: true }) });
    const input = demo.getByRole("textbox").first();
    const trigger = demo.getByRole("button", { name: t("uiDate.calendar.open"), exact: true }).first();
    await input.fill("20261115");
    await trigger.focus();
    await expect.poll(() => attempts).toBe(1);
    await trigger.press("Enter");
    const calendar = page.getByRole("dialog", { name: t("uiDate.calendar.label"), exact: true });
    await expect(calendar.getByRole("alert")).toContainText("날짜를 직접 입력");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(input).toHaveValue("2026. 11. 15.");
    await input.fill("20261117");
    await input.press("Tab");
    await expect(input).toHaveValue("2026. 11. 17.");
  } finally {
    fixture.release();
    await page.close();
  }
});
