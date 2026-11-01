// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { failure, id, screenAccess, user } from "../mock/fixtures";
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
    const auto = matrix.getByText("자동 포함", { exact: true });
    await expect(auto).toBeVisible();
    expect(await auto.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))).toBeLessThanOrEqual(1.1);
    await expect(edit.locator("..")).toHaveText("");
    await matrix.getByRole("checkbox", { name: /자동 포함/ }).focus();
    await page.keyboard.press("Space");
    await expect(edit).not.toBeChecked();
    await expect(view).not.toBeChecked();
    await expect(main.getByText(/아직 없음/)).toHaveCount(0);
    for (const label of ["역할", "부여 현황", "운영 시작 준비", "비상 관리자 계정"]) await expect(nav.getByRole("link", { name: new RegExp(label) })).toBeVisible();
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

  test(`ops tab is current and offers no grant action at ${width}px ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    const fixture = await mockAccessScreen(page, accessScreens[0], "populated");
    await mockRoute(page, "get", "/api/v1/users", { status: 200, json: { items: [{ ...user, id: id(20), display_name: "운영 계정" }], total: 1, limit: 200, offset: 0 } });
    await mockRoute(page, "get", "/api/v1/access/accounts/{accountId}/effective", { status: 200, json: { ...screenAccess("/access/people/" + id(20)), account_id: id(20), is_ops: true } });
    await mockRoute(page, "get", "/api/v1/access/grants", { status: 200, json: [] });
    await page.goto(`/access/people/${id(20)}?grant=true`);
    const main = page.getByRole("main");
    const nav = main.getByRole("navigation", { name: "권한 화면" });
    await expect(nav.getByRole("link", { name: "비상 관리자 계정", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: /부여 현황/ })).not.toHaveAttribute("aria-current", "page");
    await expect(main.getByText("운영 계정(ops)은 역할 없이 모든 권한을 가집니다.", { exact: false })).toBeVisible();
    await expect(main.getByRole("button", { name: "권한 부여", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "권한 부여", exact: true })).toHaveCount(0);
    await expectAxe(page, `ops account ${width} ${colorScheme}`);
    await fits(page, `ops account ${width} ${colorScheme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const status of [403, 503] as const) test(`ops tab hides after a ${status} read`, async ({ page }) => {
  const fixture = await mockAccessScreen(page, accessScreens[1], "populated");
  await mockRoute(page, "get", "/api/v1/access/ops", { status, json: failure(status === 403 ? "forbidden" : "service_unavailable") });
  const read = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/access/ops" && response.status() === status);
  await page.goto("/access/roles");
  await read;
  const nav = page.getByRole("navigation", { name: "권한 화면" });
  await expect(nav.getByRole("link", { name: /역할/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: "비상 관리자 계정", exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
