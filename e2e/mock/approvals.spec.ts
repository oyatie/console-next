// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAccessible, expectAxe, fits } from "../a11y";
import { recordShifts } from "../stability";
import { failure } from "./fixtures";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const item = {
  id: "approval-1", box: "pending", title: "영업 조직 개편안", summary: "영업1팀과 영업2팀을 하나의 조직으로 합칩니다.", document_no: "AP-2026-001",
  source: { key: "org_change", label: "조직 변경" }, status: { key: "IN_APPROVAL" },
  requester: { id: "account-1", name: "김기안", role: "인사팀" }, requested_at: "2026-11-03T01:00:00Z", due_at: "2026-11-05T01:00:00Z",
  facts: [{ key: "effective", label: "시행일", value: "2026. 11. 10." }],
  route: [
    { id: "first", role_key: "hr", assignee: "김기안", state: "done", meta: "11. 3. 10:00" },
    { id: "finance", role_key: "finance", assignee: "이재무", state: "done" },
    { id: "approve", role_key: "legal", assignee: "박결재", state: "current", meta: "내 차례" },
    { id: "executive", role_key: "executive", assignee: "정경영", state: "future" },
    { id: "last", role_key: "hr", assignee: "최인사", state: "future" },
  ],
  viewer: { kind: "org_change", id: "change-1" },
} as const;

const response = (box = "pending") => ({
  items: box === "pending" ? [item] : [], focused: null, next_cursor: null,
  counts: { pending: 2, upcoming: 1, requested: 3, reference: 4, completed: 9 },
  sources: [{ key: "org_change", label: "조직 변경", count: 2 }, { key: "governance", label: "예외 승인", count: 1 }],
});

async function mockApprovals(page: Page, reply: "ready" | "failed" | "refused" = "ready") {
  const queries: URLSearchParams[] = [];
  await page.route(url => url.pathname === "/api/v1/approvals", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    if (reply === "failed") return route.fulfill({ status: 503, json: failure("service_unavailable") });
    if (reply === "refused") return route.fulfill({ status: 403, json: failure("forbidden") });
    return route.fulfill({ status: 200, json: response(query.get("box") ?? "pending") });
  });
  return queries;
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`approval inbox filters, previews and opens a viewer at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordShifts);
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "empty");
    const queries = await mockApprovals(page);
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { level: 1, name: "결재함", exact: true })).toBeVisible();
    if (width === 390) await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
    await expect(page.getByRole("navigation", { name: t("shell.nav") }).getByRole("link", { name: "결재함", exact: true })).toBeVisible();
    if (width === 390) await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
    const tabs = page.getByRole("navigation", { name: "결재함 구분", exact: true });
    await expect(tabs.getByRole("link")).toHaveCount(5);
    await expect(tabs.getByRole("link", { name: /대기/ })).toHaveAttribute("aria-current", "page");
    const row = page.getByRole("row", { name: /영업 조직 개편안/ });
    await expect(row.getByText(item.document_no, { exact: true })).toBeVisible();
    if (width === 390) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(280);
    await expect(row.getByText("김기안", { exact: true })).toBeVisible();
    await expectAccessible(page, `approval list ${width}px ${theme}`);
    if (width === 390) await fits(page, "approval list");
    await page.screenshot({ path: info.outputPath(`approvals-${width}-${theme}-before.png`), fullPage: true });
    await page.getByRole("row", { name: /영업 조직 개편안/ }).click();
    const panel = page.locator("[data-side-panel]");
    await expect(panel.getByRole("heading", { name: "영업 조직 개편안", exact: true })).toBeVisible();
    await expect(panel.getByText(t("enum.orgChangeStatus.IN_APPROVAL"), { exact: true })).toBeVisible();
    await expect(panel.getByText(/hr|executive|IN_APPROVAL/, { exact: true })).toHaveCount(0);
    const chain = panel.getByRole("list", { name: "결재선", exact: true });
    await expect(chain.getByRole("listitem")).toHaveCount(item.route.length);
    await expect(chain.locator('[aria-current="step"]')).toContainText(`${t("enum.approvalRole.legal")} · 박결재`);
    if (width === 1440) {
      const rowHeight = await row.evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue("--row-h")));
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(rowHeight + 1);
      for (const text of [item.document_no]) {
        const metrics = await row.getByText(text, { exact: true }).evaluate(el => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return { height: range.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) };
        });
        expect(metrics.height, `${text} stays on one line in the split list`).toBeLessThanOrEqual(metrics.lineHeight + 1);
      }
    }
    await expect(row.getByRole("list")).toHaveCount(0);
    await expect(row.locator('[aria-current="step"]')).toHaveText(`${t("enum.approvalRole.legal")} · 박결재`);
    await expect(panel.getByRole("link", { name: "결재 문서 열기", exact: true })).toHaveAttribute("href", "/approvals/approval-1");
    await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`approvals-${width}-${theme}-preview.png`), fullPage: true });
    // Preview opening inherits a shell shift; keep its axe audit separate from the list arrival audit.
    await expectAxe(page, `approval inbox ${width}px ${theme}`);
    if (width === 390) await fits(page, "approval inbox");
    await panel.getByRole("button", { name: t(width === 390 ? "common.back" : "common.closePanel"), exact: true }).click();
    await page.getByRole("button", { name: /문서 종류/ }).click();
    await page.getByRole("option", { name: /조직 변경/ }).click();
    await expect.poll(() => queries.at(-1)?.get("source")).toBe("org_change");
    await tabs.getByRole("link", { name: /예정/ }).click();
    await expect(page).toHaveURL(/box=upcoming/);
    await expect(page.getByRole("heading", { name: "예정된 결재가 없습니다", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "결재 문서 검색", exact: true }).fill("영업");
    await expect.poll(() => queries.at(-1)?.get("q")).toBe("영업");
    expect(mock.unexpected).toEqual([]);
  });
}

test("approval rows keep absent document numbers and routes unknown", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = await mockScreen(page, screens[0], "empty");
  await page.route(url => url.pathname === "/api/v1/approvals", route => route.fulfill({ status: 200,
    json: { ...response(), items: [{ ...item, document_no: null, route: [], requester: null }] },
  }));
  await page.goto("/approvals");
  const row = page.getByRole("row", { name: /영업 조직 개편안/ });
  await expect(row.getByRole("gridcell", { name: "—", exact: true })).toHaveCount(3);
  await expect(row.getByRole("list")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
  expect(mock.unexpected).toEqual([]);
});

test("a completed route does not invent a current signer", async ({ page }) => {
  await mockScreen(page, screens[0], "empty");
  await page.route(url => url.pathname === "/api/v1/approvals", route => route.fulfill({ json: {
    ...response(), items: [{ ...item, box: "completed", status: { key: "APPLIED" }, route: item.route.map(step => ({ ...step, state: "done" })) }],
  } }));
  await page.goto("/approvals?box=completed");
  const row = page.getByRole("row", { name: /영업 조직 개편안/ });
  await expect(row.getByRole("gridcell", { name: "—", exact: true })).toHaveCount(1);
  await expect(row.locator('[aria-current="step"]')).toHaveCount(0);
  await row.click();
  await expect(page.locator("[data-side-panel]").getByRole("listitem")).toHaveCount(item.route.length);
});

test("an unavailable approvals module hides the rail entry and refuses a direct URL", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "empty", "not-ready");
  const queries = await mockApprovals(page);
  await page.goto("/approvals");
  await expect(page.getByRole("navigation", { name: t("shell.nav") }).getByRole("link", { name: "결재함", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "결재함", exact: true })).toHaveCount(0);
  await expect(page.getByText("module_disabled", { exact: true })).toBeVisible();
  expect(queries).toEqual([]);
  expect(mock.unexpected).toEqual([]);
});

for (const state of ["failed", "refused"] as const) {
  test(`approval inbox keeps safe chrome when its read is ${state}`, async ({ page }) => {
    const mock = await mockScreen(page, screens[0], "empty");
    await mockApprovals(page, state);
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { level: 1, name: "결재함", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "결재함 구분", exact: true })).toBeVisible();
    if (state === "failed") await expect(page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible({ timeout: 20_000 });
    else await expect(page.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
    await expect(page.locator("[data-id]")).toHaveCount(0);
    expect(mock.unexpected).toEqual([]);
  });
}
