// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { AT, id } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { expectStable, recordShifts } from "../stability";

async function filtersFixture(page: Page) {
  const shell = await mockScreen(page, screens[0], "empty");
  const requests: URLSearchParams[] = [];
  await page.route(url => url.pathname === "/api/v1/access/access-log", async route => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    const items = query.get("action") === "employee.rrn_reveal" ? [] : [{
      event_id: id(7100), created_at: AT, occurred_at: AT, actor_id: id(101), actor_name: "김민수",
      principal_type: "TENANT_USER", action: "employee.export", target_type: "employee", subject_count: 1,
      ip: "203.0.113.10", outcome: "ALLOWED", export_purpose: "급여 신고", row_count: 1, flags: ["download"],
    }];
    await route.fulfill({ json: {
      period: { from: "2026-10-01", to: "2026-11-01", time_zone: "Asia/Seoul", closed: true },
      totals: { events: items.length, flagged: items.length, by_flag: { download: items.length } },
      items, next_cursor: null,
      filter_options: {
        actors: [{ id: id(101), label: "김민수" }],
        actions: [{ id: "employee.export", label_key: "accessLog.action.employee.export" }, { id: "employee.rrn_reveal", label_key: "accessLog.action.employee.rrn_reveal" }],
        target_types: [{ id: "employee", label_key: "accessLog.target.employee" }],
      },
    } });
  });
  return { ...shell, requests };
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`access-log structured Korean filters at ${width}px in ${theme} @ui-state`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await filtersFixture(page);
    try {
      await page.goto("/audit/access-log?period=2026-10&view=all");
      await expect(page.getByRole("grid")).toBeVisible();
      await expectStable(page, "audit filters initial");
      await page.getByRole("button", { name: "필터 선택", exact: true }).click();
      const actor = page.getByRole("combobox", { name: "접속자", exact: true });
      await actor.selectOption({ label: "김민수" });
      await page.getByRole("combobox", { name: "동작", exact: true }).selectOption({ label: "직원 명부 내보내기" });
      await page.getByRole("combobox", { name: "대상 종류", exact: true }).selectOption({ label: "직원" });
      await page.getByLabel("시작일", { exact: true }).fill("2026-10-05");
      await page.getByLabel("종료일", { exact: true }).fill("2026-10-20");
      await page.getByRole("button", { name: "필터 적용", exact: true }).click();
      await expect.poll(() => Object.fromEntries(fixture.requests.at(-1)!)).toMatchObject({
        period: "2026-10", flagged: "false", actor: id(101), action: "employee.export", target_type: "employee", from: "2026-10-05", to: "2026-10-20",
      });
      expect(fixture.requests.at(-1)!.has("search")).toBe(false);
      expect(fixture.requests.at(-1)!.has("cursor")).toBe(false);
      await expect(page.getByLabel("적용한 필터", { exact: true })).toContainText("직원 명부 내보내기");
      await expect(page.getByLabel("적용한 필터", { exact: true })).toContainText("김민수");
      await expect(page.getByLabel("적용한 필터", { exact: true })).toContainText("직원");
      const search = page.getByRole("searchbox", { name: "접속자·IP 주소 검색" });
      await expect(search).toBeVisible();
      await search.fill("김민수");
      await expect.poll(() => Object.fromEntries(fixture.requests.at(-1)!)).toMatchObject({
        search: "김민수", actor: id(101), action: "employee.export", target_type: "employee", from: "2026-10-05", to: "2026-10-20",
      });
      await fits(page, "audit search with filters");
      await expectAxe(page, "audit search with filters");
      await page.screenshot({ path: testInfo.outputPath("search-with-filters.png"), fullPage: true });
      await page.reload();
      await page.getByRole("button", { name: "필터 선택", exact: true }).click();
      await expect(actor).toHaveValue(id(101));
      await expect(page.getByLabel("종료일", { exact: true })).toHaveValue("2026. 10. 20.");
      await page.getByRole("button", { name: "닫기", exact: true }).click();
      await page.getByRole("link", { name: /^확인 대상/ }).click();
      await expect.poll(() => fixture.requests.at(-1)!.get("flagged")).toBe("true");
      expect(fixture.requests.at(-1)!.get("action")).toBe("employee.export");
      await page.getByRole("button", { name: "필터 선택", exact: true }).click();
      await fits(page, "audit structured filters");
      await expectStable(page, "audit structured filters");
      await expectAxe(page, "audit structured filters");
      await page.screenshot({ path: testInfo.outputPath("filters.png"), fullPage: true });
      await page.getByRole("combobox", { name: "동작", exact: true }).selectOption({ label: "주민등록번호 열람" });
      await page.getByRole("button", { name: "필터 적용", exact: true }).click();
      await expect(page.getByRole("heading", { name: "검색 결과가 없습니다" })).toBeVisible();
      expect(fixture.requests.at(-1)!.get("search")).toBe("김민수");
      await page.getByRole("button", { name: "검색 초기화", exact: true }).click();
      await expect(page.getByRole("grid")).toBeVisible();
      await page.getByRole("button", { name: "필터 선택", exact: true }).click();
      await expect(actor).toHaveValue("");
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ period: "2026-10" });
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); }
  });
}

for (const [name, from, to, invalidField] of [
  ["reversed range", "2026-10-20", "2026-10-05", "종료일"],
  ["start before month", "2026-09-30", "2026-10-05", "시작일"],
  ["end after month", "2026-10-05", "2026-11-01", "종료일"],
  ["unreadable start", "날짜", "2026-10-05", "시작일"],
  ["unreadable end", "2026-10-05", "날짜", "종료일"],
] as const) test(`access-log refuses ${name} before requesting records @ui-state`, async ({ page }) => {
  const fixture = await filtersFixture(page);
  try {
    await page.goto("/audit/access-log?period=2026-10");
    await expect(page.getByRole("grid")).toBeVisible();
    await page.getByRole("button", { name: "필터 선택", exact: true }).click();
    await page.getByLabel("시작일", { exact: true }).fill(from);
    await page.getByLabel("종료일", { exact: true }).fill(to);
    const readsBeforeApply = fixture.requests.length;
    await page.getByRole("button", { name: "필터 적용", exact: true }).click();
    await expect(page.getByLabel(invalidField, { exact: true })).toHaveAttribute("aria-invalid", "true");
    expect(fixture.requests).toHaveLength(readsBeforeApply);
    expect(new URL(page.url()).searchParams.has("from")).toBe(false);
  } finally { fixture.release(); }
});

test("access-log explains an unavailable server filter @ui-state", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(recordShifts);
  await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
  const fixture = await filtersFixture(page);
  try {
    await page.route(url => url.pathname === "/api/v1/access/access-log", route => new URL(route.request().url()).searchParams.get("actor") === "unavailable" ? route.fulfill({
      status: 422, json: { error: { code: "filter_invalid", message: "choose an available option" } },
    }) : route.fallback());
    await page.goto("/audit/access-log?actor=unavailable");
    await expect(page.getByText("필터의 선택 항목과 기간을 확인한 뒤 다시 조회하십시오.", { exact: true })).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
    await fits(page, "audit filter refusal");
    await expectAxe(page, "audit filter refusal");
    await expectStable(page, "audit filter refusal");
    await page.screenshot({ path: testInfo.outputPath("filter-refusal.png"), fullPage: true });
    await page.getByRole("button", { name: "필터 선택", exact: true }).click();
    await page.getByRole("combobox", { name: "접속자", exact: true }).selectOption({ label: "김민수" });
    await page.getByRole("button", { name: "필터 적용", exact: true }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    await page.getByRole("button", { name: "검색 초기화", exact: true }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    expect(new URL(page.url()).searchParams.has("actor")).toBe(false);
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`access-log recovers filter choices after refusal at ${width}px in ${theme} @ui-state`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await filtersFixture(page);
    await page.route(url => url.pathname === "/api/v1/access/access-log" && url.searchParams.get("actor") === "unavailable",
      route => route.fulfill({ status: 422, json: { error: { code: "filter_invalid", message: "choose an available option" } } }));
    try {
      await page.goto("/audit/access-log?period=2026-10&view=all&actor=unavailable&action=employee.export&target_type=employee&from=2026-10-05&to=2026-10-20");
      await expect(page.getByText("필터의 선택 항목과 기간을 확인한 뒤 다시 조회하십시오.", { exact: true })).toBeVisible();
      const summary = page.getByLabel("적용한 필터", { exact: true });
      await expect(summary).toContainText("직원 명부 내보내기");
      await expect(summary).toContainText("직원");
      await expect(summary).toContainText("2026. 10. 05.");
      await expect(page.getByRole("button", { name: "필터 선택", exact: true })).toHaveCount(1);
      await page.getByRole("button", { name: "필터 선택", exact: true }).click();
      await page.getByRole("combobox", { name: "접속자", exact: true }).selectOption({ label: "김민수" });
      await fits(page, "audit filter recovery");
      await expectAxe(page, "audit filter recovery");
      await page.screenshot({ path: testInfo.outputPath("filter-recovery.png"), fullPage: true });
      await page.getByRole("button", { name: "필터 적용", exact: true }).click();
      await expect(page.getByRole("grid")).toBeVisible();
      await expect(summary).toContainText("김민수");
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ actor: id(101), period: "2026-10", view: "all", action: "employee.export", target_type: "employee", from: "2026-10-05", to: "2026-10-20" });
      expect(fixture.requests.some(query => query.get("flagged") === "false" && !query.has("actor"))).toBe(true);
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); }
  });
}

for (const state of ["unsupported", "failed", "refused"] as const) {
  test(`access-log filter choices handle ${state} server reads @ui-state`, async ({ page }) => {
    const fixture = await filtersFixture(page);
    await page.route(url => url.pathname === "/api/v1/access/access-log", route => {
      const actor = new URL(route.request().url()).searchParams.get("actor");
      return actor ? route.fulfill({ status: 422, json: { error: { code: "filter_invalid", message: "choose an available option" } } })
        : state === "unsupported" ? route.fulfill({ json: { period: { from: "2026-10-01", to: "2026-11-01" }, items: [], next_cursor: null, totals: { events: 0, flagged: 0, by_flag: {} } } })
        : route.fulfill({ status: state === "failed" ? 503 : 403, json: { error: { code: state === "failed" ? "service_unavailable" : "access_denied", message: "unavailable" } } });
    });
    try {
      await page.goto("/audit/access-log?period=2026-10&actor=unavailable");
      await expect(page.getByText("필터의 선택 항목과 기간을 확인한 뒤 다시 조회하십시오.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "필터 선택", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "접속기록 필터" });
      await expect(sheet.getByRole("combobox")).toHaveCount(0);
      if (state === "unsupported") await expect(sheet.getByText("필터를 사용할 수 없습니다", { exact: true })).toBeVisible();
      else if (state === "failed") await expect(sheet.getByText("불러오지 못했습니다", { exact: true })).toBeVisible({ timeout: 20_000 });
      else await expect(sheet.getByText("이 화면에 접근 권한이 없습니다", { exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); }
  });
}

test("access-log month changes clear choices from the previous month @ui-state", async ({ page }) => {
  const fixture = await filtersFixture(page);
  try {
    await page.goto(`/audit/access-log?period=2026-10&view=all&actor=${id(101)}&action=employee.export&target_type=employee&from=2026-10-05&to=2026-10-20`);
    await expect(page.getByRole("grid")).toBeVisible();
    await page.getByLabel("점검 기간", { exact: true }).fill("2026-11");
    await expect.poll(() => Object.fromEntries(fixture.requests.at(-1)!)).toEqual({ period: "2026-11", flagged: "false", limit: "200" });
    expect(new URL(page.url()).searchParams.has("actor")).toBe(false);
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});
