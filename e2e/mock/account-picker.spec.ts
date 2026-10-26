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

async function fixture(page: Page, delay?: number) {
  const screen = await mockScreen(page, screens[1], "populated");
  if (delay !== undefined) await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { items: [{
    key: "display.search_debounce", kind: { type: "int" }, default: delay, value: delay,
    looser_when: "neutral", governance: "tenant", legal_basis: null, version: "code_default", effective_from: null, scheduled: [],
  }] } });
  const searches: string[] = [];
  let failRefetch = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        window.addEventListener("picker-refetch", () => controller.enqueue(new TextEncoder().encode('event: change\ndata: {"type":"employee","id":null}\n\n')));
        request.signal.addEventListener("abort", () => controller.close(), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }));
    };
  });
  await mockRoute(page, "get", "/api/v1/directory/people", async request => {
    const params = new URL(request.url()).searchParams;
    const search = params.get("search") ?? "";
    searches.push(search);
    if (search === "대기") await held;
    if (search === "실패" || failRefetch) return { status: 503, json: failure("service_unavailable") };
    const items = search === "없음" ? [] : search.startsWith("검색계정") ? accounts.filter(p => p.display_name.includes(search)) : search ? accounts : accounts.slice(0, 3);
    return { status: 200, json: { items, total: search === "없음" ? 0 : search ? 1271 : 3, limit: Number(params.get("limit")), offset: Number(params.get("offset") ?? 0) } };
  });
  await page.goto("/people?view=accounts");
  const search = page.getByRole("combobox", { name: "계정 이름·사번 검색", exact: true });
  await expect(search).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("grid", { name: "계정", exact: true })).toBeVisible();
  return { ...screen, search, searches, release, failRefetch: () => { failRefetch = true; } };
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

test("Tab after hovering and editing preserves the query until a result is explicitly focused", async ({ page }) => {
  const f = await fixture(page);
  await f.search.fill("이전이름");
  await page.getByRole("option", { name: /검색계정 2 PICK-2/ }).hover();
  await f.search.fill("검색계정 3");
  await expect(page.getByRole("option", { name: /검색계정 3 PICK-3/ })).toBeVisible();
  await f.search.press("Tab");
  await expect(f.search).toHaveValue("검색계정 3");
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
  await f.search.focus();
  await f.search.press("ArrowDown");
  await f.search.press("Tab");
  await expect(page).toHaveURL(new RegExp(`sel=${accounts[2]!.id}`));
  await expect(page.getByRole("complementary", { name: "검색계정 3", exact: true })).toBeVisible();
  expect(f.unexpected).toEqual([]);
});

test("account search debounces typing and waits for IME composition to end", async ({ page }) => {
  const f = await fixture(page, 2000);
  await page.clock.install();
  f.searches.length = 0;
  await f.search.pressSequentially("PICK", { delay: 10 });
  await page.clock.fastForward(1000);
  expect(f.searches).toEqual([]);
  await page.clock.fastForward(2000);
  await expect.poll(() => f.searches).toEqual(["PICK"]);
  await expect(page.getByRole("option")).toHaveCount(50);
  await f.search.dispatchEvent("compositionstart");
  for (const text of ["ㄱ", "거", "검", "검색"]) {
    await f.search.fill(text);
    await page.clock.fastForward(1000);
    expect(f.searches).toEqual(["PICK"]);
    await expect(page.getByRole("option", { name: /검색계정/ })).toHaveCount(0);
  }
  await f.search.dispatchEvent("compositionend", { data: "검색" });
  await page.clock.fastForward(2000);
  await expect.poll(() => f.searches).toEqual(["PICK", "검색"]);
  await expect(f.search).toBeFocused();
  expect(f.unexpected).toEqual([]);
});

test("Tab preserves keyboard selection and never commits an unmatched hovered result", async ({ page }) => {
  const f = await fixture(page);
  await f.search.fill("이전이름");
  await page.getByRole("option", { name: /검색계정 2 PICK-2/ }).hover();
  await f.search.press("Tab");
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
  await f.search.focus();
  await f.search.press("ArrowDown");
  await f.search.press("ArrowDown");
  await f.search.press("Tab");
  await expect(page).toHaveURL(new RegExp(`sel=${accounts[1]!.id}`));
  expect(f.unexpected).toEqual([]);
});

test("a failed background account refetch drops the previous total as well as the choices", async ({ page }) => {
  const f = await fixture(page);
  await f.search.fill("이전이름");
  await expect(page.getByRole("status").filter({ hasText: /^1,271건$/ })).toHaveCount(1);
  f.failRefetch();
  await page.evaluate(() => window.dispatchEvent(new Event("picker-refetch")));
  await expect(f.search).toHaveAttribute("aria-invalid", "true", { timeout: 20_000 });
  await expect(page.getByRole("option", { name: /검색계정/ })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /^0건$/ })).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: /^1,271건$/ })).toHaveCount(0);
  await expect(page.getByText("처음 50건만 표시합니다. 검색어를 더 입력해 범위를 좁히십시오.", { exact: true })).toHaveCount(0);
  expect(f.unexpected).toEqual([]);
});

test("pending, empty and failed account searches keep focus and never offer stale accounts", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.search.fill("이전이름");
    await expect(page.getByRole("option")).toHaveCount(50);
    await f.search.fill("대기");
    await expect(page.getByRole("status").filter({ hasText: /^찾는 중$/ })).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: /^1,271건$/ })).toHaveCount(0);
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
