// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { authz, employees, failure, id, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

type User = components["schemas"]["UserSummary"];
const employee = { ...employees(1)[0]!, name: "김직원", employee_number: "EMP-12", company: "연결회사", org_unit: "인사팀" };
const linked: User = { ...user, id: id(500), display_name: "김계정", employee_id: employee.id,
  employee_name: employee.name, employee_number: employee.employee_number, employee_company: employee.company,
  employee_org_unit: employee.org_unit, employee_link_status: "LINKED" };
const unlinked: User = { ...linked, employee_id: null, employee_name: null, employee_number: null,
  employee_company: null, employee_org_unit: null, employee_link_status: "UNLINKED" };

async function fixture(page: Page, initial: User = linked) {
  const shell = await mockScreen(page, screens[1], "populated");
  let account = initial;
  let searchFailed = false;
  const writes: unknown[] = [];
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz,
    capabilities: [...authz.capabilities, { feature: "user_manage", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }],
  } });
  await mockRoute(page, "get", "/api/v1/directory/people", () => ({ status: 200, json: { items: [account], total: 1, limit: 100, offset: 0 } }));
  await mockRoute(page, "get", "/api/v1/users/{id}", request => new URL(request.url()).pathname.endsWith(id(404))
    ? { status: 404, json: failure("not_found") } : { status: 200, json: account });
  await mockRoute(page, "get", "/api/v1/person-binding-reviews", { status: 200, json: { items: [], total: 0, limit: 100, offset: 0 } });
  await mockRoute(page, "get", "/api/v1/employees", () => searchFailed
    ? { status: 503, json: failure("service_unavailable") }
    : { status: 200, json: { items: [employee], total: 1, limit: 20, offset: 0, next_cursor: null } });
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 200, json: {
    ceremony_id: id(600), expires_at: "2099-01-01T00:00:00Z", challenge: { publicKey: { challenge: "AQID", rpId: "localhost" } },
  } });
  // The API is exercised; only the physical passkey device is replaced.
  await page.addInitScript(() => Object.defineProperty(navigator.credentials, "get", {
    value: async () => ({ toJSON: () => ({ id: "test-passkey", type: "public-key" }) }),
  }));
  await mockRoute(page, "patch", "/api/v1/users/{id}", request => {
    const body = request.postDataJSON();
    writes.push(body);
    account = body.employee_id === null ? unlinked : linked;
    return { status: 200, json: account };
  });
  return { ...shell, writes, failSearch: () => { searchFailed = true; } };
}

for (const width of [1440, 390]) {
  test(`the gallery includes a person reference at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto("/_gallery?entry=links");
    await expect(page.getByRole("link", { name: /1번 직원.*E-001.*한결물산.*인사부/ })).toHaveAttribute("href", "/people/gallery-person");
    await expectAxe(page, "person reference gallery");
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
  });

  test(`account rows and panel name the linked person at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    await page.goto(`/people?view=accounts&sel=${linked.id}`);
    const grid = page.getByRole("grid", { name: "계정", exact: true });
    const person = grid.getByRole("link", { name: /김직원.*EMP-12.*연결회사.*인사팀/ });
    await expect(person).toHaveAttribute("href", `/people/${employee.id}`);
    await expect(grid.getByRole("link", { name: /^김계정/ })).toHaveCount(0);
    const section = page.getByRole("complementary", { name: "김계정", exact: true }).getByRole("region", { name: "직원 연결", exact: true });
    await expect(section.getByRole("link", { name: /김직원.*EMP-12.*연결회사.*인사팀/ })).toHaveAttribute("href", `/people/${employee.id}`);
    await expectAxe(page, "account person references");
    await fits(page, "account person references");
    expect(f.unexpected).toEqual([]);
  });

  test(`link and unlink refresh the person reference at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page, unlinked);
    await page.goto(`/people?view=accounts&sel=${linked.id}`);
    const section = page.getByRole("region", { name: "직원 연결", exact: true });
    await section.getByRole("combobox", { name: "연결할 직원", exact: true }).fill("김직원");
    await page.getByRole("option", { name: /김직원/ }).click();
    await section.getByRole("button", { name: "패스키로 확인하고 직원 연결", exact: true }).click();
    await expect(section.getByRole("link", { name: /김직원.*EMP-12.*연결회사.*인사팀/ })).toBeVisible();
    await section.getByRole("button", { name: "패스키로 확인하고 연결 해제", exact: true }).click();
    await expect(section.getByRole("combobox", { name: "연결할 직원", exact: true })).toBeVisible();
    expect(f.writes).toEqual([
      { employee_id: employee.id, step_up: { ceremony_id: id(600), credential: { id: "test-passkey", type: "public-key" } } },
      { employee_id: null, step_up: { ceremony_id: id(600), credential: { id: "test-passkey", type: "public-key" } } },
    ]);
    await page.reload();
    await expect(section.getByRole("combobox", { name: "연결할 직원", exact: true })).toBeVisible();
    expect(f.unexpected).toEqual([]);
  });
}

test("a missing account offers an action that closes its panel @ui-state", async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/people?view=accounts&sel=${id(404)}`);
  const panel = page.getByRole("complementary", { name: "계정", exact: true });
  await expect(panel.getByRole("heading", { name: "기록을 찾을 수 없습니다", exact: true })).toBeVisible();
  await panel.getByRole("link", { name: "계정 목록으로", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/view=accounts$/);
  expect(f.unexpected).toEqual([]);
});

test("a failed person search reports the refusal without an empty-result claim @ui-state", async ({ page }) => {
  const f = await fixture(page, unlinked);
  f.failSearch();
  await page.goto(`/people?view=accounts&sel=${linked.id}`);
  const search = page.getByRole("combobox", { name: "연결할 직원", exact: true });
  await search.fill("김직원");
  await expect(search).toHaveAttribute("aria-invalid", "true", { timeout: 20_000 });
  await expect(page.getByRole("option", { name: /김직원/ })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "일치하는 결과가 없습니다", exact: true })).toHaveCount(0);
  await expect(page.getByText("일치하는 직원이 없습니다. 직원 기록이 없으면 먼저 직원을 등록합니다.", { exact: true })).toHaveCount(0);
  expect(f.unexpected).toEqual([]);
});

for (const initial of [linked, unlinked]) {
  test(`a pending ${initial.employee_id ? "unlink" : "link"} preserves the stored identity @ui-state`, async ({ page }) => {
    const f = await fixture(page, initial);
    await mockRoute(page, "patch", "/api/v1/users/{id}", { status: 202, json: { ...initial, account_link: {
      status: "PENDING", request_id: id(700), requested_by: user.id, requester_name: user.display_name,
      user_id: initial.id, employee_id: initial.employee_id ? null : employee.id,
    } } });
    await page.goto(`/people?view=accounts&sel=${initial.id}`);
    const section = page.getByRole("region", { name: "직원 연결", exact: true });
    if (!initial.employee_id) {
      await section.getByRole("combobox", { name: "연결할 직원", exact: true }).fill("김직원");
      await page.getByRole("option", { name: /김직원/ }).click();
    }
    await section.getByRole("button", { name: initial.employee_id ? "패스키로 확인하고 연결 해제" : "패스키로 확인하고 직원 연결", exact: true }).click();
    await expect(section).toContainText("확인 대기");
    await expect(section).toContainText(user.display_name);
    await expect(section).toContainText(initial.employee_id ? "연결 안 됨" : "김직원");
    await expect(section.getByRole("button", { name: /승인/ })).toHaveCount(0);
    const grid = page.getByRole("grid", { name: "계정", exact: true });
    await expect(grid.getByRole("link", { name: /김직원.*EMP-12/ })).toHaveCount(initial.employee_id ? 1 : 0);
    expect(f.writes).toEqual([]);
    expect(f.unexpected).toEqual([]);
  });
}

for (const code of ["account_link_self_forbidden", "account_link_second_person_required", "account_link.refuse.identity_unbound", "account_link_stale"]) {
  test(`a link refusal retains the person and command: ${code} @ui-state`, async ({ page }) => {
    const f = await fixture(page);
    const message = "직원 연결 요청을 다시 확인하십시오.";
    await mockRoute(page, "patch", "/api/v1/users/{id}", { status: code === "account_link_stale" ? 409 : 403,
      json: { error: { ...failure(code).error, message } } });
    await page.goto(`/people?view=accounts&sel=${linked.id}`);
    const section = page.getByRole("region", { name: "직원 연결", exact: true });
    await section.getByRole("button", { name: "패스키로 확인하고 연결 해제", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText(code);
    await expect(section.getByRole("link", { name: /김직원.*EMP-12.*연결회사.*인사팀/ })).toBeVisible();
    await expect(section.getByRole("button", { name: "패스키로 확인하고 연결 해제", exact: true })).toBeEnabled();
    expect(f.writes).toEqual([]);
    expect(f.unexpected).toEqual([]);
  });
}
