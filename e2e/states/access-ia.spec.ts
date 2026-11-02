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
    const active = nav.getByRole("link", { name: "비상 관리자 계정", exact: true });
    await expect(active).toHaveAttribute("aria-current", "page");
    await expect.poll(() => active.evaluate(el => {
      const tab = el.getBoundingClientRect(), bar = el.parentElement!.getBoundingClientRect();
      return tab.left >= bar.left && tab.right <= bar.right + 1;
    })).toBe(true);
    await expect(nav.getByRole("link", { name: /부여 현황/ })).not.toHaveAttribute("aria-current", "page");
    await expect(main.getByText("운영 계정(ops)은 역할 없이 모든 권한을 가집니다.", { exact: false })).toBeVisible();
    await expect(main.getByRole("button", { name: "권한 부여", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "권한 부여", exact: true })).toHaveCount(0);
    await expectAxe(page, `ops account ${width} ${colorScheme}`);
    await fits(page, `ops account ${width} ${colorScheme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) test(`grant picker distinguishes accounts with colliding name and sign-in masks at ${width}px ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const fixture = await mockAccessScreen(page, accessScreens[0], "populated");
  const accounts = ["worker1234", "writer1234"].map((login, i) => ({ ...user, id: id(100 + i), display_name: "동명 계정",
    employee_id: null, employee_name: null, employee_number: null, employee_company: null, employee_org_unit: null,
    sign_in_id: `${login}@example.test`, created_at: `2026-10-01T01:00:${i === 0 ? "00" : "30"}Z`,
  }));
  await mockRoute(page, "get", "/api/v1/users", { status: 200, json: { items: accounts, total: 2, limit: 200, offset: 0 } });
  await mockRoute(page, "get", "/api/v1/access/grants", { status: 200, json: fixture.grants.slice(0, 2) });
  await page.goto("/access/grants");
  await page.getByRole("button", { name: "권한 부여", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "권한 부여할 사람", exact: true });
  await picker.getByRole("combobox").fill("동명");
  await expect(page.getByText(/계정 생성 시각으로 구분합니다/)).toBeVisible();
  const first = page.getByRole("option", { name: /동명 계정.*계정 생성.*10:00.*orker1234/ });
  const second = page.getByRole("option", { name: /동명 계정.*계정 생성.*10:00.*riter1234/ });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  for (const option of [first, second]) {
    const context = option.getByText(/계정 생성/);
    const layout = await context.evaluate(el => {
      const bounds = el.closest('[role="option"]')!.getBoundingClientRect();
      const rects = Array.from(el.getClientRects());
      return { fits: rects.every(rect => rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom), bounds: bounds.toJSON(), rects: rects.map(rect => rect.toJSON()) };
    });
    expect(layout.fits, JSON.stringify(layout)).toBe(true);
  }
  expect(await first.evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await second.evaluate(el => el.getBoundingClientRect().top));
  for (const account of accounts) await expect(picker).not.toContainText(account.id);
  await expectAxe(page, `same-name account picker ${width} ${colorScheme}`);
  await fits(page, `same-name account picker ${width} ${colorScheme}`);
  await second.click();
  const sheet = page.getByRole("dialog", { name: "권한 부여", exact: true });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: /동명 계정.*계정 생성.*10:00.*orker1234/ })).toBeVisible();
  await expect(main.getByRole("link", { name: /동명 계정.*계정 생성.*10:00.*riter1234/ })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

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

for (const status of [403, 503] as const) test(`person access keeps the grants marker and hides missing identity ids after ops ${status}`, async ({ page }) => {
  const fixture = await mockAccessScreen(page, accessScreens[0], "populated");
  const account = { ...user, id: id(100), display_name: "검증직원", employee_id: null, employee_number: null,
    employee_name: null, employee_company: null, employee_org_unit: null, sign_in_id: null };
  await mockRoute(page, "get", "/api/v1/users", { status: 200, json: { items: [account], total: 1, limit: 200, offset: 0 } });
  await mockRoute(page, "get", "/api/v1/access/ops", { status, json: failure(status === 403 ? "forbidden" : "service_unavailable") });
  await mockRoute(page, "get", "/api/v1/access/accounts/{accountId}/effective", { status: 200, json: { ...screenAccess(`/access/people/${account.id}`), account_id: account.id } });
  await mockRoute(page, "get", "/api/v1/access/grants", { status: 200, json: [] });
  await page.goto(`/access/people/${account.id}`);
  const main = page.getByRole("main");
  const nav = main.getByRole("navigation", { name: "권한 화면" });
  await expect(nav.getByRole("link", { name: /부여 현황/ })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "비상 관리자 계정", exact: true })).toHaveCount(0);
  await expect(main.getByRole("heading", { name: account.display_name, exact: true })).toBeVisible();
  await expect(main.getByText("식별 정보 없음", { exact: false })).toBeVisible();
  await expect(main).not.toContainText(account.id);
  await expectAxe(page, `person access ops ${status}`);
  expect(fixture.unexpected).toEqual([]);
});
