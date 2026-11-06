// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { AT, failure, id, screenAccess } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { accessScreens, mockAccessScreen } from "./access";
import { screens } from "./registry";

type State = "populated" | "empty" | "failed" | "refused";
const event = (n: number) => ({
  event_id: id(5000 + n), created_at: AT, occurred_at: AT, actor_id: id(100 + n), actor_name: `점검직원 ${n}`,
  principal_type: "TENANT_USER", action: n % 2 ? "employee.export" : "employee.rrn_reveal", target_type: "employee",
  subject_count: n, ip: "203.0.113.10", outcome: n % 3 ? "ALLOWED" : "DENIED", export_purpose: n % 2 ? "급여 신고" : null,
  row_count: n % 2 ? n : null, flags: n % 2 ? ["download"] : ["sensitive_read"],
});

async function mockAccessLog(page: Page, state: State, count = state === "empty" ? 0 : 3) {
  const shell = await mockScreen(page, screens[0], "empty");
  const rows = Array.from({ length: count }, (_, i) => event(i + 1));
  let pageCalls = 0;
  await page.route(url => url.pathname === "/api/v1/access/access-log", async route => {
    pageCalls += 1;
    const query = new URL(route.request().url()).searchParams;
    const offset = Number(query.get("cursor") ?? 0), end = Math.min(offset + 200, rows.length);
    const error = state === "failed" ? { status: 503, json: failure("service_unavailable") }
      : state === "refused" ? { status: 403, json: failure("forbidden") } : null;
    await route.fulfill(error ?? { status: 200, json: {
      period: { key: "2026-10", from: "2026-10-01", to: "2026-11-01", time_zone: "Asia/Seoul", closed: true },
      totals: { events: rows.length, flagged: rows.length, by_flag: { download: Math.ceil(rows.length / 2), sensitive_read: Math.floor(rows.length / 2) } },
      items: rows.slice(offset, end), next_cursor: end < rows.length ? String(end) : null,
    } });
  });
  return { ...shell, pageCalls: () => pageCalls };
}

for (const screen of ["access-log", "access-review"] as const) for (const state of ["populated", "empty", "failed", "refused"] as const) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`${screen}: ${state} at ${width}px in ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = screen === "access-log" ? await mockAccessLog(page, state) : await mockAccessScreen(page, accessScreens[0], state);
    try {
      await page.goto(screen === "access-log" ? "/audit/access-log" : "/access/review");
      const main = page.getByRole("main");
      if (state === "failed") await expect(main.getByText("불러오지 못했습니다", { exact: true })).toHaveCount(1, { timeout: 20_000 });
      else if (state === "refused") await expect(main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toHaveCount(1);
      else if (state === "empty") await expect(main.getByRole("heading", { name: screen === "access-log" ? "확인할 접속기록이 없습니다" : "검토할 권한 부여가 없습니다" })).toBeVisible();
      else await expect(main.getByRole("grid")).toBeVisible();
      if (state === "failed" || state === "refused") await expect(main.getByRole("grid")).toHaveCount(0);
      if (width === 390) await fits(page, `${screen}/${state}/${width}/${theme}`);
      await expectAxe(page, `${screen}/${state}/${width}/${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  });
}

test("access-log details contain facts without implementation prose", async ({ page }) => {
  const fixture = await mockAccessLog(page, "populated");
  await page.goto("/audit/access-log");
  await page.getByRole("grid").getByRole("row").nth(1).click();
  await expect(page.getByText("서버에 기록된 접속 사실을 표시합니다.", { exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("both review lists keep 2,000 rows virtualized", async ({ page }) => {
  const log = await mockAccessLog(page, "populated", 2000);
  await page.goto("/audit/access-log");
  const logGrid = page.getByRole("grid");
  await expect(logGrid).toHaveAttribute("aria-rowcount", "2001");
  while (log.pageCalls() < 10) {
    const before = log.pageCalls();
    await logGrid.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(log.pageCalls).toBeGreaterThan(before);
  }
  expect(log.pageCalls()).toBeGreaterThanOrEqual(10);
  expect(await logGrid.getByRole("row").count()).toBeLessThan(100);
  expect(log.unexpected).toEqual([]);
  await page.goto("about:blank");
  log.release();

  const grants = await mockAccessScreen(page, accessScreens[0], "large");
  await page.goto("/access/review");
  const grantGrid = page.getByRole("grid");
  await expect(grantGrid).toHaveAttribute("aria-rowcount", "2001");
  await grantGrid.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(grantGrid.getByText("ACC-2000", { exact: true })).toBeVisible();
  expect(await grantGrid.getByRole("row").count()).toBeLessThan(100);
  expect(grants.unexpected).toEqual([]);
  grants.release();
});

test("the role editor offers support-access approval only when the server catalog does", async ({ page }) => {
  const fixture = await mockAccessScreen(page, accessScreens[1], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/access/roles/new") });
  await mockRoute(page, "get", "/api/v1/access/catalog", { status: 200, json: {
    domains: [{ domain: "support_access", grantable: true, levels: ["approve"], operations: [{ operation: "support_access::approve", level: "approve" }] }],
    levels: ["approve"], scope_kinds: [{ kind: "TENANT", enforceable: true, descendants_only: true }], reason_domain: "role_change",
  } });
  await page.goto("/access/roles/new");
  await expect(page.getByRole("checkbox", { name: "지원 접근 승인" })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) test(`org approval can be prepared before routing is enabled at ${width}px ${theme}`, async ({ page }, info) => {
  const fixture = await mockAccessScreen(page, accessScreens[1], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/access/roles/new") });
  await mockRoute(page, "get", "/api/v1/access/catalog", { status: 200, json: {
    domains: [{ domain: "org", grantable: true, levels: ["view", "approve"], operations: [
      { operation: "org_change_read", level: "view" }, { operation: "org_change_approve", level: "approve" },
    ] }],
    levels: ["view", "approve"], scope_kinds: [{ kind: "TENANT", enforceable: true, descendants_only: true }], reason_domain: "role_change",
  } });
  await page.route(url => url.pathname === "/api/v1/settings", route => route.fulfill({ json: {
    items: [{ key: "approval.policy.org_structure", value: "none" }],
  } }));
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/access/roles/new");
  await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
  const approval = page.getByRole("checkbox", { name: "조직 결재", exact: true });
  await expect(approval).toBeVisible();
  await approval.check();
  await expect(approval).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^조직 조회 · 자동 포함/ })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.screenshot({ path: info.outputPath(`org-approval-role-${width}-${theme}.png`), fullPage: true });
  await expectAxe(page, `org approval authority ${width}px ${theme}`);
  await fits(page, "org approval authority");
  expect(fixture.unexpected).toEqual([]);
});
