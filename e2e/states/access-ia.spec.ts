// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { screenAccess } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { accessScreens, mockAccessScreen } from "./access";

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) {
  test(`first use opens the role editor with keyboard checkboxes at ${width}px ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    const fixture = await mockAccessScreen(page, accessScreens[1], "empty");
    await mockRoute(page, "get", "/api/v1/access/catalog", { status: 200, json: {
      domains: [
        { domain: "hr_basic", grantable: true, levels: ["view", "edit"], operations: [{ operation: "employee.update", level: "edit" }] },
        { domain: "pay", grantable: true, levels: ["view"], operations: [] },
      ], levels: ["view", "edit"], scope_kinds: [], reason_domain: "role_change",
    } });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/access/roles/new") });
    await page.goto("/access/roles");
    const main = page.getByRole("main");
    const nav = main.getByRole("navigation", { name: "권한 화면" });
    for (const label of ["역할", "부여 현황", "권한 검토", "비상 관리자 계정"]) await expect(nav.getByRole("link", { name: new RegExp(label) })).toBeVisible();
    await expect(main.getByText("역할에 할 수 있는 일을 정한 뒤, 사람에게 범위와 종료일을 지정해 부여합니다.", { exact: true })).toBeVisible();
    await main.getByRole("link", { name: "역할 추가", exact: true }).click();
    const matrix = main.getByRole("table", { name: "데이터 영역별 권한" });
    const view = matrix.getByRole("checkbox", { name: "인사기본 조회", exact: true });
    const edit = matrix.getByRole("checkbox", { name: "인사기본 등록·수정", exact: true });
    await expect(view).not.toBeChecked();
    await edit.focus();
    await page.keyboard.press("Space");
    await expect(edit).toBeChecked();
    await expect(matrix.getByRole("checkbox", { name: /자동 포함/ })).toBeChecked();
    await expect(matrix.getByText("자동 포함", { exact: true })).toBeVisible();
    await matrix.getByRole("checkbox", { name: /자동 포함/ }).focus();
    await page.keyboard.press("Space");
    await expect(edit).not.toBeChecked();
    await expect(view).not.toBeChecked();
    await expect(main.getByText(/아직 없음/)).toHaveCount(0);
    await expectAxe(page, `access first use ${width} ${colorScheme}`);
    await fits(page, `access first use ${width} ${colorScheme}`);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`grant period has a visible end-date label at ${width}px ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    const fixture = await mockAccessScreen(page, accessScreens[0], "populated");
    await page.goto("/access/grants");
    await page.getByRole("button", { name: "권한 부여", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "권한 부여할 사람", exact: true });
    await picker.getByRole("combobox").fill("ACC-0002");
    await page.getByRole("option", { name: /ACC-0002/ }).click();
    const sheet = page.getByRole("dialog", { name: "권한 부여", exact: true });
    const end = sheet.getByRole("group", { name: "종료일", exact: true });
    await expect(end.getByText("종료일", { exact: true })).toBeVisible();
    await expect(end.getByText("종료일", { exact: true })).not.toHaveClass(/sr-only/);
    await end.getByRole("button", { name: /^3개월/ }).click();
    await expect(end.getByRole("button", { name: /^3개월/ })).toHaveAttribute("aria-pressed", "true");
    await expectAxe(page, `grant period ${width} ${colorScheme}`);
    await fits(page, `grant period ${width} ${colorScheme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}
