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
const replacement = { ...employee, id: id(501), name: "이직원", employee_number: "EMP-13" };

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
    : { status: 200, json: { items: [employee, replacement], total: 2, limit: 20, offset: 0, next_cursor: null } });
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
  return { ...shell, writes, setAccount: (next: User) => { account = next; }, failSearch: () => { searchFailed = true; }, recoverSearch: () => { searchFailed = false; } };
}

for (const width of [1440, 390]) {
  test(`direct relink keeps the current employee until independent confirmation at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page);
    const writes: Record<string, unknown>[] = [];
    await mockRoute(page, "patch", "/api/v1/users/{id}", request => {
      writes.push(request.postDataJSON());
      return { status: 202, json: { ...linked, account_link: {
        status: "PENDING" as const, request_id: id(700), requested_by: user.id, requester_name: user.display_name,
        user_id: linked.id, employee_id: replacement.id,
      } } };
    });
    await page.goto(`/people?view=accounts&sel=${linked.id}`);
    const section = page.getByRole("region", { name: "직원 연결", exact: true });
    await section.getByRole("button", { name: "직원 변경", exact: true }).click();
    await expect(section.getByRole("link", { name: /김직원.*EMP-12/ })).toBeVisible();
    const picker = section.getByRole("combobox", { name: "연결할 직원", exact: true });
    await picker.fill("직원");
    await expect(page.getByRole("option", { name: /김직원/ })).toHaveCount(0);
    await page.getByRole("option", { name: /이직원/ }).click();
    const submit = section.getByRole("button", { name: "패스키로 확인하고 직원 변경 요청", exact: true });
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
      await fits(page, `relink draft ${theme}`);
    }
    await expectAxe(page, "relink draft");
    await submit.click();
    await expect(section).toContainText("확인 대기");
    await expect(section).toContainText("이직원");
    await expect(section.getByRole("link", { name: /김직원.*EMP-12/ })).toBeVisible();
    await expect(section.getByRole("button", { name: /승인/ })).toHaveCount(0);
    expect(writes).toEqual([{ employee_id: replacement.id, step_up: { ceremony_id: id(600), credential: { id: "test-passkey", type: "public-key" } } }]);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
      await fits(page, `pending relink ${theme}`);
    }
    await expectAxe(page, "pending relink");
    expect(f.unexpected).toEqual([]);
  });
}

test("cancelling a relink draft and changing the search never submits the previous selection @ui-state", async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/people?view=accounts&sel=${linked.id}`);
  const section = page.getByRole("region", { name: "직원 연결", exact: true });
  await section.getByRole("button", { name: "직원 변경", exact: true }).click();
  const picker = section.getByRole("combobox", { name: "연결할 직원", exact: true });
  await picker.fill("이직원");
  await page.getByRole("option", { name: /이직원/ }).click();
  await picker.fill("다른 검색");
  await section.getByRole("button", { name: "패스키로 확인하고 직원 변경 요청", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("연결할 직원을 선택하십시오");
  await section.getByRole("button", { name: "취소", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(section.getByRole("link", { name: /김직원.*EMP-12/ })).toBeVisible();
  expect(f.writes).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test("a second person confirms the frozen relink with a fresh passkey @ui-state", async ({ page }) => {
  const f = await fixture(page);
  const writes: Record<string, unknown>[] = [];
  await mockRoute(page, "patch", "/api/v1/users/{id}", request => {
    const body = request.postDataJSON();
    writes.push(body);
    if (!body.account_link_request_id) return { status: 202, json: { ...linked, account_link: {
      status: "PENDING" as const, request_id: id(700), requested_by: id(701), requester_name: "김요청",
      user_id: linked.id, employee_id: replacement.id,
    } } };
    const confirmed = { ...linked, employee_id: replacement.id, employee_name: replacement.name, employee_number: replacement.employee_number };
    f.setAccount(confirmed);
    return { status: 200, json: confirmed };
  });
  await page.goto(`/people?view=accounts&sel=${linked.id}`);
  const section = page.getByRole("region", { name: "직원 연결", exact: true });
  await section.getByRole("button", { name: "직원 변경", exact: true }).click();
  await section.getByRole("combobox", { name: "연결할 직원", exact: true }).fill("이직원");
  await page.getByRole("option", { name: /이직원/ }).click();
  await section.getByRole("button", { name: "패스키로 확인하고 직원 변경 요청", exact: true }).click();
  await expect(section).toContainText("김요청");
  await section.getByRole("button", { name: "패스키로 확인하고 승인", exact: true }).click();
  await expect(section.getByRole("link", { name: /이직원.*EMP-13/ })).toBeVisible();
  await expect(section).not.toContainText("확인 대기");
  await page.reload();
  await expect(section.getByRole("link", { name: /이직원.*EMP-13/ })).toBeVisible();
  expect(writes).toEqual([
    { employee_id: replacement.id, step_up: { ceremony_id: id(600), credential: { id: "test-passkey", type: "public-key" } } },
    { employee_id: replacement.id, account_link_request_id: id(700), step_up: { ceremony_id: id(600), credential: { id: "test-passkey", type: "public-key" } } },
  ]);
  expect(f.unexpected).toEqual([]);
});

for (const [code, status, copy] of [
  ["account_link_self_forbidden", 403, "본인 계정의 직원 연결은 변경할 수 없습니다"],
  ["account_link_second_person_required", 403, "요청자와 다른 확인 권한자가 승인해야 합니다"],
  ["account_link.refuse.identity_unbound", 403, "본인 정보를 확인할 수 없어 거부했습니다"],
  ["account_link_stale", 409, "현재 연결이 바뀌었습니다"],
  ["step_up_required", 428, "내 패스키로 본인 확인을 해야 합니다"],
  ["step_up_failed", 401, "패스키를 확인하지 못했습니다"],
] as const) {
  test(`direct relink preserves the current employee on ${code} @ui-state`, async ({ page }) => {
    const f = await fixture(page);
    await mockRoute(page, "patch", "/api/v1/users/{id}", { status, json: failure(code) });
    await page.goto(`/people?view=accounts&sel=${linked.id}`);
    const section = page.getByRole("region", { name: "직원 연결", exact: true });
    await section.getByRole("button", { name: "직원 변경", exact: true }).click();
    await section.getByRole("combobox", { name: "연결할 직원", exact: true }).fill("이직원");
    await page.getByRole("option", { name: /이직원/ }).click();
    await section.getByRole("button", { name: "패스키로 확인하고 직원 변경 요청", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText(copy);
    await expect(section.getByRole("link", { name: /김직원.*EMP-12/ })).toBeVisible();
    await expect(section.getByRole("button", { name: "패스키로 확인하고 직원 변경 요청", exact: true })).toBeEnabled();
    expect(f.writes).toEqual([]);
    expect(f.unexpected).toEqual([]);
  });
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
    const person = grid.getByRole("link", { name: new RegExp(`^${employee.name}`) });
    await expect(person).toHaveAttribute("href", `/people/${employee.id}`);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
      await expect.poll(() => person.getByText(employee.name, { exact: true }).evaluate(el => {
        const name = el.getBoundingClientRect();
        const cell = el.closest('[role="gridcell"], [role="rowheader"]')!.getBoundingClientRect();
        return name.top >= cell.top && name.bottom <= cell.bottom && name.left >= cell.left && name.right <= cell.right && el.scrollWidth <= el.clientWidth;
      }), { message: `the full linked name fits its cell in ${theme}` }).toBe(true);
      await fits(page, "account person references");
    }
    await expect(person).toHaveText(employee.name);
    await expect(grid.getByRole("rowheader").getByRole("link", { name: employee.name, exact: true })).toHaveCount(width === 390 ? 1 : 0);
    const section = page.getByRole("complementary", { name: "김계정", exact: true }).getByRole("region", { name: "직원 연결", exact: true });
    await expect(section.getByRole("link", { name: /김직원.*EMP-12.*연결회사.*인사팀/ })).toHaveAttribute("href", `/people/${employee.id}`);
    await expectAxe(page, "account person references");
    await fits(page, "account person references");
    await page.goto("/people?view=accounts");
    await expect(person).toBeVisible();
    await expect(grid.getByRole("rowheader").getByRole("link", { name: employee.name, exact: true })).toHaveCount(width === 390 ? 1 : 0);
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
  await expect(page.getByRole("status").filter({ hasText: "0건" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "잠시 뒤 다시 시도하십시오." })).toBeVisible();
  f.recoverSearch();
  await page.getByRole("button", { name: "다시 불러오기", exact: true, includeHidden: true }).click();
  await expect(search).not.toHaveAttribute("aria-invalid", "true");
  await search.press("ArrowDown");
  await expect(page.getByRole("option", { name: /김직원/ })).toBeVisible();
  expect(f.unexpected).toEqual([]);
});

test("a failed refresh removes previously loaded people from the picker @ui-state", async ({ page }) => {
  const f = await fixture(page, unlinked);
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        const refresh = () => controller.enqueue(new TextEncoder().encode('event: change\ndata: {"type":"employee","id":null}\n\n'));
        window.addEventListener("person-refresh", refresh);
        request.signal.addEventListener("abort", () => { window.removeEventListener("person-refresh", refresh); controller.close(); }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }));
    };
  });
  await page.goto(`/people?view=accounts&sel=${linked.id}`);
  const search = page.getByRole("combobox", { name: "연결할 직원", exact: true });
  await search.fill("김직원");
  await expect(page.getByRole("option", { name: /김직원/ })).toBeVisible();
  await search.press("Escape");
  f.failSearch();
  // Live invalidation keeps the cached query data while refreshing it.
  await page.evaluate(() => window.dispatchEvent(new Event("person-refresh")));
  await expect(search).toHaveAttribute("aria-invalid", "true", { timeout: 20_000 });
  await search.press("ArrowDown");
  await expect(page.getByRole("option", { name: /김직원/ })).toHaveCount(0);
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
    await expect(grid.getByRole("link", { name: new RegExp(`^${employee.name}`) })).toHaveCount(initial.employee_id ? 1 : 0);
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
