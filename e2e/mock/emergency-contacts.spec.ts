// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { AT } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { moveDetail } from "./lifecycle-sheets";

for (const width of [1440, 390]) {
  test(`unconfirmed emergency contact actions remain clickable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/employees/{id}/personal-facts", { status: 200, json: {
      employee_id: moveDetail.employee.id, updated_at: AT,
      name_hanja: null, name_en: null, nationality: null, personal_email: null,
      photo: null, group_service_start_date: null,
      emergency_contacts: [{ name: "이세리", relation: "SIBLING", phone: "+821055556666", contact_notified: false }],
    } });
    await page.goto(`/people/${moveDetail.employee.id}`);
    const row = page.getByRole("list", { name: "비상연락처", exact: true }).getByRole("listitem");
    await expect(row.getByText("당사자 안내 미확인", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: /더보기/ }).click({ timeout: 5_000 });
    await expect(page.getByRole("menuitem", { name: "무효화", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: /수정/ }).click({ timeout: 5_000 });
    const edit = page.getByRole("dialog", { name: "비상연락처 수정", exact: true });
    await expect(edit.getByRole("checkbox")).not.toBeChecked();
    await edit.getByRole("button", { name: "닫기", exact: true }).last().click();
    await page.getByRole("button", { name: "비상연락처 추가", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "비상연락처 추가", exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  });
}
