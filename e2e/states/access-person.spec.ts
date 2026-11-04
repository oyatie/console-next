// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { AT, failure, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { accessPerson, accessScreens, mockAccessScreen } from "./access";

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  test(`access account detail and refusal states at ${width}px ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    const f = await mockAccessScreen(page, accessScreens[0], "populated");
    const account = accessPerson({ ...f.accounts[0]!, employee_id: id(900), employee_name: "김직원", employee_company: "연결회사", employee_org_unit: "인사팀" });
    await mockRoute(page, "get", "/api/v1/users", { status: 200, json: { items: [], total: 0, limit: 200, offset: 0 } });
    let reads = 0;
    // The route is deliberately absent from the account list: detail owns its own read.
    await mockRoute(page, "get", "/api/v1/access/people/{id}", () => {
      reads++;
      return { status: 200, json: account };
    });
    await mockRoute(page, "get", "/api/v1/access/accounts/{accountId}/effective", { status: 200, json: {
      account_id: account.id, is_ops: false, phase: "OPERATING", as_of: AT, entries: [],
    } });
    await page.goto(`/access/people/${account.id}`);
    await expect(page.getByRole("link", { name: "김직원", exact: true })).toHaveAttribute("href", `/people/${id(900)}`);
    await expect(page.getByText(/ACC-0001 · 연결회사 · 인사팀/)).toHaveCount(1);
    expect(reads).toBeGreaterThan(0);
    await expectAxe(page, "access account detail");
    await fits(page, "access account detail");
    for (const status of [403, 404] as const) {
      await mockRoute(page, "get", "/api/v1/access/people/{id}", { status, json: failure(status === 403 ? "access_denied" : "not_found") });
      await page.reload();
      const main = page.getByRole("main");
      await expect(main.getByRole("link", { name: "부여 현황", exact: true }).last()).toHaveAttribute("href", "/access/grants");
      await expect(main.getByRole("heading", { name: status === 403 ? "이 화면에 접근 권한이 없습니다" : "기록을 찾을 수 없습니다", exact: true })).toBeVisible();
      await expect(main.getByRole("button", { name: "권한 부여", exact: true })).toHaveCount(0);
      await expect(main.getByText("김직원", { exact: true })).toHaveCount(0);
      await expectAxe(page, `access account ${status}`);
      await fits(page, `access account ${status}`);
    }
    expect(f.unexpected).toEqual([]);
  });
}
