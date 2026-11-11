// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";
import { filingTask, mockFilings } from "./filings";

const refresh = "**/api/v1/auth/token/refresh";
async function refuseWrite(page: Page, path: string) {
  const writes: { key: string; body: unknown }[] = [];
  await page.route(path, route => {
    if (route.request().method() !== "POST") return route.fallback();
    writes.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
    return route.fulfill({ status: 401, json: { error: { code: "unauthorized" } } });
  });
  await page.route(refresh, route => route.abort());
  return writes;
}

for (const width of [1440, 390]) {
  test(`lifecycle renewal refusal stays editable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = lifecycleSheetScreens[0];
    const fixture = await mockScreen(page, screen, "populated");
    await page.goto(screen.path);
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("combobox", { name: "어디로", exact: true }).fill("재무팀");
    await page.getByRole("option", { name: /재무팀/ }).click();
    await sheet.getByRole("button", { name: /^오늘 / }).click();
    await sheet.getByRole("textbox", { name: /^사유/ }).fill("사업장 이동");
    const writes = await refuseWrite(page, "**/api/v1/employees/*/lifecycle-events");
    await sheet.getByRole("button", { name: /1명 적용$/ }).click();
    await expect(sheet).toContainText("연결되지 않아 저장하지 않았습니다");
    await expect(sheet.getByRole("button", { name: "기록됐는지 확인" })).toHaveCount(0);
    await expect(sheet.getByRole("textbox", { name: /^사유/ })).toBeEditable();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
      await fits(page, `lifecycle-renewal-${width}-${theme}`);
      await expectAxe(page, `lifecycle renewal ${width} ${theme}`);
    }
    expect(writes).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`filing request resubmits current values after renewal refusal at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[0], "populated");
    await mockFilings(page, { ...filingTask, insurer: "EI" });
    await page.goto("/statutory");
    await page.getByRole("button", { name: "신고 요청·근로월 기록", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "김신고 · 신고 요청·근로월 기록" });
    await sheet.getByRole("button", { name: /신고 종류$/ }).click();
    await page.getByRole("option", { name: "근로자 요청 취득 신고" }).click();
    const date = sheet.getByRole("textbox", { name: /^요청일·근로월 말일/ });
    await date.fill("2026-09-02");
    const writes = await refuseWrite(page, "**/api/v1/statutory/insurance-filings");
    const submit = sheet.getByRole("button", { name: "요청·근로월 기록", exact: true });
    await submit.click();
    await expect(sheet).toContainText("연결되지 않아 저장하지 않았습니다");
    await expect(sheet.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
      await fits(page, `filing-renewal-${width}-${theme}`);
      await expectAxe(page, `filing renewal ${width} ${theme}`);
    }
    await date.fill("2026-09-03");
    await submit.click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[0]!.key).toBeTruthy();
    expect(writes[1]!.key).toBe(writes[0]!.key);
    expect(writes[1]!.body).toMatchObject({ anchor_on: "2026-09-03" });
    expect(fixture.unexpected).toEqual([]);
  });
}
