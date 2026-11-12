// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { AT } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { moveDetail } from "./lifecycle-sheets";

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  test(`nationality catalog picker and refusal at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/employees/{id}/personal-facts", { status: 200, json: {
      employee_id: moveDetail.employee.id, updated_at: AT,
      name_hanja: null, name_en: null, nationality: "GB", personal_email: null,
      photo: null, group_service_start_date: null, emergency_contacts: null,
      countries: [
        { code: "GB", label_ko: "영국", label_en: "United Kingdom" },
        { code: "VN", label_ko: "베트남", label_en: "Vietnam" },
      ],
    } });
    await mockRoute(page, "patch", "/api/v1/employees/{id}", { status: 422, json: {
      error: { code: "nationality_unknown", message: "요청을 처리하지 못했습니다." },
    } });
    await page.goto(`/people/${moveDetail.employee.id}`);
    if (theme === "dark") await page.getByRole("button", { name: "어두운 화면으로 전환", exact: true }).click();
    await expect(page.getByText("영국 · GB", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "국적 · 신분증 수정", exact: true }).click();
    const picker = page.getByRole("combobox", { name: "국적 · 신분증", exact: true });
    await picker.fill("UK");
    await expect(page.getByRole("option", { name: /영국|베트남/ })).toHaveCount(0);
    await picker.press("Escape");
    await expect(page.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
    await picker.fill("베트남");
    await picker.press("ArrowDown");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("picker.png"), fullPage: true });
    const request = page.waitForRequest(r => r.method() === "PATCH" && r.url().includes(`/employees/${moveDetail.employee.id}`));
    await picker.press("Enter");
    expect((await request).postDataJSON().changes).toEqual({ nationality: "VN" });
    await expect(page.getByText("국가 목록에 없는 코드입니다. 목록에서 국가를 선택하십시오. 영국의 국가 코드는 GB입니다.", { exact: false })).toBeVisible();
    await expect(page.getByText("영국 · GB", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(fixture.unexpected).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("nationality.png"), fullPage: true });
  });
}
