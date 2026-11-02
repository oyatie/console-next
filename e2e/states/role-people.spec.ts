// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { AT, failure, id, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { accessRole, accessScreens, mockAccessScreen } from "./access";

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) {
  test(`role editor shows its served version and distinct holders at ${width}px ${colorScheme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    const f = await mockAccessScreen(page, accessScreens[1], "populated");
    Object.assign(f.accounts[0]!, { employee_id: id(900), employee_name: "김직원", employee_company: "연결회사", employee_org_unit: "인사팀" });
    const role = { ...accessRole, version: 7, holder_count: 2 };
    await mockRoute(page, "get", "/api/v1/access/roles/{roleId}", { status: 200, json: role });
    await mockRoute(page, "get", "/api/v1/access/roles/{roleId}/versions", { status: 200, json: [
      { ...role, change_mode: "OPERATING", created_at: AT, created_by: user.id },
      { ...role, version: 6, name_ko: "인사 기초 조회", change_mode: "SETUP", created_at: AT, created_by: user.id },
    ] });
    await mockRoute(page, "get", "/api/v1/access/grants", { status: 200, json: [f.grants[0]!, { ...f.grants[0]!, id: id(800) }, f.grants[1]!] });
    await page.goto(`/access/roles/${role.id}`);
    await expect(page.getByText("버전 7", { exact: true })).toBeVisible();
    const holders = page.getByRole("region", { name: "보유자", exact: true });
    await expect(holders.getByRole("listitem")).toHaveCount(2);
    for (const account of f.accounts.slice(0, 2)) await expect(holders.getByRole("link", { name: new RegExp(`${account.display_name}.*${account.employee_number}`) }))
      .toHaveAttribute("href", `/access/people/${account.id}`);
    const linked = holders.getByRole("listitem").first();
    await expect(linked.getByText("ACC-0001 · 연결회사 · 인사팀", { exact: true })).toHaveCount(1);
    await expect(linked.getByRole("link", { name: "김직원", exact: true })).toHaveAttribute("href", `/people/${id(900)}`);
    await expect(holders.getByRole("listitem").nth(1).getByText("ACC-0002", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("table", { name: "역할 버전", exact: true }).getByRole("row")).toHaveCount(3);
    await expect(page.getByRole("cell", { name: "인사 기초 조회", exact: true })).toBeVisible();
    await expectAxe(page, "role holders and version");
    await fits(page, "role holders and version");
    expect(f.unexpected).toEqual([]);
  });
}

test("missing and refused role reads retain a route back to roles @ui-state", async ({ page }) => {
  const f = await mockAccessScreen(page, accessScreens[1], "populated");
  for (const status of [404, 403] as const) {
    await mockRoute(page, "get", "/api/v1/access/roles/{roleId}", { status, json: failure(status === 404 ? "not_found" : "forbidden") });
    await page.goto(`/access/roles/${accessRole.id}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "역할 목록", exact: true })).toHaveAttribute("href", "/access/roles");
    await expect(main.getByRole("textbox")).toHaveCount(0);
  }
  expect(f.unexpected).toEqual([]);
});

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) test(`a failed holder read offers one error and prevents a blind role edit at ${width}px ${colorScheme} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const f = await mockAccessScreen(page, accessScreens[1], "populated");
  await mockRoute(page, "get", "/api/v1/access/roles/{roleId}", { status: 200, json: accessRole });
  await mockRoute(page, "get", "/api/v1/access/roles/{roleId}/versions", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/access/grants", { status: 503, json: failure("service_unavailable") });
  await page.goto(`/access/roles/${accessRole.id}`);
  const holders = page.getByRole("region", { name: "보유자", exact: true });
  await expect(holders.getByRole("alert")).toContainText("불러오지 못했습니다", { timeout: 20_000 });
  await expect(page.getByText("불러오지 못했습니다", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "다시 불러오기", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "역할 저장", exact: true })).toBeDisabled();
  await expectAxe(page, "failed role holders");
  await fits(page, "failed role holders");
  await mockRoute(page, "get", "/api/v1/access/grants", { status: 200, json: f.grants });
  await holders.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await expect(holders.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "역할 저장", exact: true })).toBeEnabled();
  expect(f.unexpected).toEqual([]);
});

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) test(`account access names the linked person once and missing accounts return to grants at ${width}px ${colorScheme} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const f = await mockAccessScreen(page, accessScreens[0], "populated");
  const account = f.accounts[0]!;
  Object.assign(account, { employee_id: id(900), employee_name: "김직원", employee_company: "연결회사", employee_org_unit: "인사팀" });
  await mockRoute(page, "get", "/api/v1/access/accounts/{accountId}/effective", { status: 200, json: {
    account_id: account.id, is_ops: false, phase: "OPERATING", as_of: AT, entries: [],
  } });
  await page.goto(`/access/people/${account.id}`);
  await expect(page.getByRole("link", { name: "김직원", exact: true })).toHaveAttribute("href", `/people/${id(900)}`);
  await expect(page.getByText(/ACC-0001 · 연결회사 · 인사팀/)).toHaveCount(1);
  await expectAxe(page, "linked person access");
  await fits(page, "linked person access");
  await mockRoute(page, "get", "/api/v1/access/accounts/{accountId}/effective", { status: 404, json: failure("not_found") });
  await page.reload();
  await expect(page.getByRole("main").getByRole("link", { name: "부여 현황", exact: true }).last()).toHaveAttribute("href", "/access/grants");
  await expect(page.getByRole("heading", { name: "기록을 찾을 수 없습니다", exact: true })).toBeVisible();
  expect(f.unexpected).toEqual([]);
});
