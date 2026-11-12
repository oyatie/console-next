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
        { code: "GB", label_ko: "영국", label_en: "United Kingdom", search_terms: "UK" },
        { code: "VN", label_ko: "베트남", label_en: "Vietnam" },
        { code: "KR", label_ko: "대한민국", label_en: "South Korea", search_terms: "한국" },
        { code: "US", label_ko: "미국", label_en: "United States", search_terms: "USA" },
        { code: "JP", label_ko: "일본", label_en: "Japan" },
        { code: "GS", label_ko: "사우스조지아 사우스샌드위치 제도", label_en: "South Georgia & South Sandwich Islands" },
      ],
    } });
    let release = () => {};
    const held = new Promise<void>(done => { release = done; });
    let writes = 0;
    await mockRoute(page, "patch", "/api/v1/employees/{id}", async () => {
      writes++;
      await held;
      return { status: 422, json: { error: { code: "nationality_unknown", message: "요청을 처리하지 못했습니다." } } };
    });
    await page.goto(`/people/${moveDetail.employee.id}`);
    if (theme === "dark") await page.getByRole("button", { name: "어두운 화면으로 전환", exact: true }).click();
    await expect(page.getByText("영국 · GB", { exact: true })).toBeVisible();
    const edit = page.getByRole("button", { name: "국적 · 신분증 수정", exact: true });
    await edit.focus();
    await edit.press("Enter");
    const picker = page.getByRole("combobox", { name: "국적 · 신분증", exact: true });
    await expect(picker).toBeFocused();
    await picker.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(edit).toBeFocused();
    await edit.press("Enter");
    await picker.fill("no match");
    await picker.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(edit).toBeFocused();
    await edit.press("Enter");
    await expect(picker).toHaveValue("GB");
    await picker.press("Tab");
    const clear = page.getByRole("button", { name: "국적 입력 해제", exact: true });
    await expect(clear).toBeFocused();
    await clear.press("Tab");
    const cancel = page.getByRole("button", { name: "취소", exact: true });
    await expect(cancel).toBeFocused();
    await cancel.press("Enter");
    await expect(edit).toBeFocused();
    await edit.press("Enter");
    await picker.press("Tab");
    await cancel.focus();
    await cancel.press("Tab");
    await expect(picker).toHaveCount(0);
    await edit.click();
    await page.getByRole("heading", { name: moveDetail.employee.name, exact: true }).click();
    await expect(picker).toHaveCount(0);
    expect(writes).toBe(0);
    await edit.click();
    await picker.fill("ZZ");
    await expect(page.getByRole("option", { name: /영국|베트남/ })).toHaveCount(0);
    for (const [query, option] of [["한국", "대한민국 · KR"], ["USA", "미국 · US"], ["japan", "일본 · JP"], ["kr", "대한민국 · KR"], ["미국", "미국 · US"], ["사우스조지아", "사우스조지아 사우스샌드위치 제도 · GS"]]) {
      await picker.fill(query!);
      await expect(page.getByRole("option", { name: option!, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await picker.fill("베트남");
    await picker.press("ArrowDown");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("picker.png"), fullPage: true });
    const request = page.waitForRequest(r => r.method() === "PATCH" && r.url().includes(`/employees/${moveDetail.employee.id}`));
    await picker.press("Enter");
    expect((await request).postDataJSON().changes).toEqual({ nationality: "VN" });
    await expect(page.getByRole("img", { name: "저장 중", exact: true })).toBeVisible();
    await expect(edit).toBeFocused();
    release();
    await expect(page.getByText("국가 목록에 없는 코드입니다. 목록에서 국가를 선택하십시오. 영국의 국가 코드는 GB입니다.", { exact: false })).toBeVisible();
    await expect(page.getByText("영국 · GB", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(fixture.unexpected).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("nationality.png"), fullPage: true });
  });
}
