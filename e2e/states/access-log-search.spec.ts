// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { AT, failure, id } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { SEARCH_DEBOUNCE_MS } from "../../apps/web/src/lib/freshness";
import { expectStable, recordShifts } from "../stability";

async function searchFixture(page: Page) {
  const fixture = await mockScreen(page, screens[0], "empty");
  const requests: URLSearchParams[] = [];
  const event = (n: number, name: string) => ({
    event_id: id(7000 + n), created_at: AT, occurred_at: AT, actor_id: id(100 + n), actor_name: name,
    principal_type: "TENANT_USER", action: "employee.export", target_type: "employee", subject_count: 1,
    ip: "203.0.113.10", outcome: "ALLOWED", export_purpose: "급여 신고", row_count: 1, flags: ["download"],
  });
  await page.route(url => url.pathname === "/api/v1/access/access-log", async route => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    const search = query.get("search");
    if (search === "실패" || search === "거절") {
      await route.fulfill({ status: search === "실패" ? 503 : 403, json: failure(search === "실패" ? "service_unavailable" : "access_denied") });
      return;
    }
    const items = search === "없음" ? [] : search ? [event(2, "김민수")] : [event(1, "이하나")];
    await route.fulfill({ status: 200, json: {
      period: { key: "2026-10", from: "2026-10-01", to: "2026-11-01", time_zone: "Asia/Seoul", closed: true },
      totals: { events: items.length, flagged: items.length, by_flag: { download: items.length } },
      items, next_cursor: null,
      filter_options: { actors: [], actions: [], target_types: [] },
    } });
  });
  return { ...fixture, requests };
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`access-log server search and clear at ${width}px in ${theme} @ui-state`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await searchFixture(page);
    try {
      await page.goto("/audit/access-log?period=2026-10&view=all");
      await expect(page.getByRole("grid").getByText("이하나")).toBeVisible();
      await expectStable(page, "access-log initial read");
      const search = page.getByRole("searchbox", { name: "접속자·IP 주소 검색" });
      await expect(search).toHaveCount(1);
      await search.fill("  김민수  ");
      await expect(page.getByRole("grid").getByText("김민수")).toBeVisible();
      await expect(page.getByRole("grid").getByText("이하나")).toHaveCount(0);
      expect(Object.fromEntries(fixture.requests.at(-1)!)).toMatchObject({ search: "김민수", period: "2026-10", flagged: "false" });
      expect(fixture.requests.at(-1)!.has("cursor")).toBe(false);
      await fits(page, "access-log search");
      await expectStable(page, "access-log search");
      await expectAxe(page, "access-log search");
      await page.screenshot({ path: testInfo.outputPath("search.png"), fullPage: true });
      await search.fill("없음");
      await expect(page.getByRole("heading", { name: "검색 결과가 없습니다" })).toBeVisible();
      await page.getByRole("button", { name: "검색 초기화", exact: true }).click();
      await expect(search).toHaveValue("");
      await expect(page.getByRole("grid").getByText("이하나")).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); }
  });
}

for (const [searchTerm, state] of [["실패", "failed"], ["거절", "refused"]] as const) {
  test(`access-log search preserves the shared ${state} state @ui-state`, async ({ page }) => {
    const fixture = await searchFixture(page);
    try {
      await page.goto("/audit/access-log");
      await expect(page.getByRole("grid")).toBeVisible();
      await page.getByRole("searchbox", { name: "접속자·IP 주소 검색" }).fill(searchTerm);
      const main = page.getByRole("main");
      if (state === "failed") {
        await expect(main.getByText("최신 내용을 확인하지 못했습니다", { exact: false })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("grid")).toBeVisible();
      }
      else await expect(main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
      if (state === "refused") await expect(main.getByRole("grid")).toHaveCount(0);
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); }
  });
}

test("access-log waits for Korean composition before searching @ui-state", async ({ page }) => {
  const fixture = await searchFixture(page);
  try {
    await page.goto("/audit/access-log");
    await expect(page.getByRole("grid")).toBeVisible();
    const search = page.getByRole("searchbox", { name: "접속자·IP 주소 검색" });
    await expect(search).toBeVisible();
    await search.focus();
    await page.clock.install();
    await search.dispatchEvent("compositionstart");
    for (const text of ["김", "김민수"]) {
      // fill() completes Firefox's composition; dispatch an in-progress IME input instead.
      await search.evaluate((element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertCompositionText", isComposing: true }));
      }, text);
      await page.clock.runFor(SEARCH_DEBOUNCE_MS * 2);
      expect(fixture.requests.some(query => query.has("search"))).toBe(false);
    }
    await search.dispatchEvent("compositionend", { data: "김민수" });
    await page.clock.runFor(SEARCH_DEBOUNCE_MS * 2);
    await expect(page.getByRole("grid").getByText("김민수")).toBeVisible();
    expect(fixture.requests.filter(query => query.has("search")).map(query => query.get("search"))).toEqual(["김민수"]);
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});


test("access-log retains rows and focus while search refetches @ui-state", async ({ page }) => {
  const fixture = await searchFixture(page);
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const request = new Promise<void>(resolve => { requested = resolve; });
  await page.route(url => url.pathname === "/api/v1/access/access-log" && url.searchParams.get("search") === "김민수", async route => {
    requested();
    await response;
    await route.fallback();
  });
  try {
    await page.goto("/audit/access-log");
    const grid = page.getByRole("grid");
    await expect(grid.getByText("이하나")).toBeVisible();
    const search = page.getByRole("searchbox");
    await search.fill("김민수");
    await request;
    await expect(grid.getByText("이하나")).toBeVisible();
    await expect.poll(() => grid.evaluate(el => el.closest("[aria-busy]")?.getAttribute("aria-busy"))).toBe("true");
    await expect(search).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "검색 결과" })).toHaveCount(0);
    release();
    await expect(grid.getByText("김민수")).toBeVisible();
    await expect(search).toBeFocused();
  } finally { release(); fixture.release(); }
});

test("access-log search survives reload and view changes and clears from the URL @ui-state", async ({ page }) => {
  const fixture = await searchFixture(page);
  try {
    await page.goto("/audit/access-log?period=2026-10&view=all&search=김민수");
    const search = page.getByRole("searchbox");
    await expect(search).toHaveValue("김민수");
    await expect(page.getByRole("grid").getByText("김민수")).toBeVisible();
    await search.fill("203.0.113.10");
    await expect.poll(() => new URL(page.url()).searchParams.get("search")).toBe("203.0.113.10");
    await page.reload();
    await expect(search).toHaveValue("203.0.113.10");
    await page.getByRole("link", { name: /^확인 대상/ }).click();
    await expect(search).toHaveValue("203.0.113.10");
    await expect.poll(() => Object.fromEntries(fixture.requests.at(-1)!)).toMatchObject({ search: "203.0.113.10", period: "2026-10", flagged: "true" });
    await search.fill("없음");
    await expect(page.getByRole("heading", { name: "검색 결과가 없습니다" })).toBeVisible();
    await page.getByRole("button", { name: "검색 초기화", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("search")).toBe(false);
    await expect(page.getByRole("grid").getByText("이하나")).toBeVisible();
    await page.goBack();
    await expect(search).toHaveValue("203.0.113.10");
    await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ search: "203.0.113.10", period: "2026-10", view: "all" });
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});

test("access-log announces settled search counts including zero @ui-state", async ({ page }) => {
  const fixture = await searchFixture(page);
  try {
    await page.goto("/audit/access-log");
    await expect(page.getByRole("grid")).toBeVisible();
    await page.getByRole("searchbox").fill("김민수");
    await expect(page.getByRole("status").filter({ hasText: "검색 결과 1건" })).toHaveCount(1);
    await page.getByRole("searchbox").fill("없음");
    await expect(page.getByRole("status").filter({ hasText: "검색 결과 0건" })).toHaveCount(1);
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});
