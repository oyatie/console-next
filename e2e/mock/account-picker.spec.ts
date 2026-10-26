// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { AT, failure, id } from "./fixtures";
import { screens } from "../states/registry";

const accounts: components["schemas"]["DirectoryPerson"][] = Array.from({ length: 50 }, (_, n) => ({
  id: id(500 + n), display_name: `검색계정 ${n + 1}`, employee_id: id(100 + n),
  employee_name: `검색계정 ${n + 1}`, employee_number: `PICK-${n + 1}`, employee_company: "화면 검증 회사",
  employee_org_unit: "인사팀", employee_position: null, employee_identity_review_required: false,
  employee_identity_resolution_confidence: null, employee_link_status: "LINKED", team: "MANAGEMENT",
  roles: [], branch_ids: [], is_active: true, is_tenant_ops: false, has_passkey: true,
  account_status: "ACTIVE", created_at: AT,
}));

async function fixture(page: Page) {
  const screen = await mockScreen(page, screens[1], "populated");
  const searches: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/directory/people", async request => {
    const params = new URL(request.url()).searchParams;
    const search = params.get("search") ?? "";
    searches.push(search);
    if (search === "대기") await held;
    if (search === "실패") return { status: 503, json: failure("service_unavailable") };
    const items = search === "없음" ? [] : search ? accounts : accounts.slice(0, 3);
    return { status: 200, json: { items, total: search === "없음" ? 0 : search ? 1271 : 3, limit: Number(params.get("limit")), offset: Number(params.get("offset") ?? 0) } };
  });
  await page.goto("/people?view=accounts");
  const search = page.getByRole("combobox", { name: "계정 이름·사번 검색", exact: true });
  await expect(search).toBeVisible();
  return { ...screen, search, searches, release };
}

test("account search uses server matches and counts, and selecting opens the existing account panel", async ({ page }) => {
  const f = await fixture(page);
  await f.search.fill("이전이름");
  await expect(page.getByRole("option")).toHaveCount(50);
  await expect(page.getByRole("status").filter({ hasText: /^1,271건$/ })).toHaveCount(1);
  await expect(page.getByText("처음 50건만 표시합니다. 검색어를 더 입력해 범위를 좁히십시오.", { exact: true })).toBeVisible();
  await page.getByRole("option", { name: /검색계정 2 PICK-2/ }).click();
  await expect(page).toHaveURL(new RegExp(`sel=${accounts[1]!.id}`));
  await expect(page.getByRole("complementary", { name: "검색계정 2", exact: true })).toBeVisible();
  await expect(f.search).toBeFocused();
  expect(new URL(page.url()).searchParams.has("search")).toBe(false);
  expect(page.url()).not.toContain(encodeURIComponent("이전이름"));
  expect(f.searches).toContain("이전이름");
  expect(f.unexpected).toEqual([]);
});

test("pending, empty and failed account searches keep focus and never offer stale accounts", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.search.fill("이전이름");
    await expect(page.getByRole("option")).toHaveCount(50);
    await f.search.fill("대기");
    await expect(page.getByRole("status").filter({ hasText: /^찾는 중$/ })).toHaveCount(1);
    await expect(page.getByRole("option", { name: /검색계정/ })).toHaveCount(0);
    await expect(f.search).toBeFocused();
    f.release();
    await expect(page.getByRole("option")).toHaveCount(50);
    await f.search.fill("없음");
    await expect(page.getByRole("status").filter({ hasText: /^0건$/ })).toHaveCount(1);
    await expect(page.getByRole("option", { name: /검색계정/ })).toHaveCount(0);
    await f.search.fill("실패");
    await expect(f.search).toHaveAttribute("aria-invalid", "true", { timeout: 20_000 });
    await expect(page.getByRole("option", { name: /검색계정/ })).toHaveCount(0);
    await expect(f.search).toBeFocused();
    await f.search.press("Tab");
    await expect(page.getByRole("main").getByRole("button", { name: "다시 불러오기", exact: true })).toBeVisible();
    await f.search.fill("복구");
    await expect(page.getByRole("option")).toHaveCount(50);
    expect(f.unexpected).toEqual([]);
  } finally { f.release(); }
});
