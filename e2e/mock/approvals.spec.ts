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

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) test(`an identity-blocked approval explains the fix and opens the source record at ${width}px ${theme}`, async ({ page }, info) => {
  await mockScreen(page, screens[0], "empty");
  await page.route(url => url.pathname === "/api/v1/approvals", route => route.fulfill({ status: 200, json: {
    ...response(), items: [{ ...item, decision_refusal: "org_change.refuse.identity_unbound" }],
  } }));
  await mockDocument(page, { ...item, decision_refusal: "org_change.refuse.identity_unbound" });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/approvals");
  await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
  await page.getByRole("row", { name: /영업 조직 개편안/ }).click();
  const panel = column(page);
  await expect(panel).toContainText("계정을 인사카드에 연결하거나 동일인 확인을 완료");
  await expect(panel.getByRole("link", { name: "원본 기록 열기", exact: true })).toHaveAttribute("href", "/org/changes/change-1");
  await expect(panel.getByRole("link", { name: "결재 문서 열기", exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.screenshot({ path: info.outputPath(`approval-blocked-${width}-${theme}.png`), fullPage: true });
  await expectAxe(page, `blocked approval ${width}px ${theme}`);
  if (width === 390) await fits(page, "blocked approval");
});

const documentOf = (source: object) => ({ ...source, body: [{ key: "change", label: "변경 내용", value: "영업1팀과 영업2팀을 영업팀으로 통합" }],
  revision: 1, fingerprint: "sha256:approval-1-r1", consequence: "승인하면 조직 변경이 시행일에 반영됩니다.", opinion_max: 1000, my_actions: { kind: "none" } });
/** The document column reads the selected document by id. */
const mockDocument = (page: Page, source: object = item) => page.route(url => /^\/api\/v1\/approvals\/[^/]+$/.test(url.pathname),
  route => route.fulfill({ status: 200, json: documentOf({ ...source, id: decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!) }) }));
const column = (page: Page) => page.getByRole("complementary", { name: "결재 문서", exact: true });

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
    await mockDocument(page);
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
    const panel = column(page);
    await expect(panel.getByRole("heading", { name: "영업 조직 개편안", exact: true })).toBeVisible();
    await expect(panel.getByText(t("enum.orgChangeStatus.IN_APPROVAL"), { exact: true })).toBeVisible();
    await expect(panel.getByText(/hr|executive|IN_APPROVAL/, { exact: true })).toHaveCount(0);
    await expect(panel.getByText(new RegExp(t("enum.approvalRole.executive")))).toBeVisible();
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
    if (width === 1440) {
      // The row carries the 결재선 as chips: the steps around the current one, the rest counted.
      const chips = row.getByRole("list", { name: "결재선", exact: true });
      await expect(chips.locator('[aria-current="step"]')).toContainText(`${t("enum.approvalRole.legal")} · 박결재`);
      await expect(chips.getByRole("listitem").last()).toHaveText("+2");
    }
    await expect(panel.getByRole("link", { name: "원본 기록 열기", exact: true })).toHaveAttribute("href", "/org/changes/change-1");
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

for (const width of [1280, 1440]) for (const theme of ["light", "dark"]) {
  test(`approval columns preserve readable content at ${width}px ${theme}`, async ({ page }, info) => {
    const longItem = {
      ...item,
      title: "전사 영업 조직 개편 및 인사 운영 체계 변경 승인요청",
      document_no: "OC-2026-HR-1103-001",
    };
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "empty");
    await page.route(url => url.pathname === "/api/v1/approvals", route => route.fulfill({
      json: { ...response(), items: Array.from({ length: 50 }, (_, i) => ({ ...longItem, id: `approval-${i + 1}` })) },
    }));
    await mockDocument(page, longItem);
    await page.goto("/approvals");
    const grid = page.getByRole("grid", { name: t("approvals.list"), exact: true });
    const rows = grid.getByRole("row").filter({ hasText: longItem.title });
    await expect(rows).toHaveCount(50);
    for (const preview of [false, true, false]) {
      if (!preview) await expect(grid.getByRole("columnheader")).toHaveText([
        t("approvals.field.documentNo"), t("approvals.col.title"), t("approvals.col.source"),
        t("approvals.preview.route"), t("approvals.col.requester"), t("approvals.col.requestedAt"), t("approvals.col.status"),
      ]);
      await expect(grid.getByRole("columnheader", { name: t("approvals.col.title"), exact: true })).toBeVisible();
      await expect(grid.getByRole("columnheader", { name: t("approvals.col.status"), exact: true })).toBeVisible();
      const measurements = await rows.evaluateAll((elements, title) => elements.map(row => {
        const cells = Array.from(row.querySelectorAll<HTMLElement>("td"));
        const textBounds = (cell: HTMLElement) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return range.getBoundingClientRect();
        };
        const titleCell = cells.find(cell => cell.textContent === title)!;
        const titleText = titleCell.querySelector("span") ?? titleCell;
        const textNode = titleText.firstChild!;
        const style = getComputedStyle(titleCell);
        const ellipsis = titleText.scrollWidth > titleText.clientWidth ? parseFloat(style.fontSize) : 0;
        const right = titleCell.getBoundingClientRect().right - parseFloat(style.paddingRight) - ellipsis;
        let visibleCharacters = 0;
        for (let i = 0; i < title.length; i++) {
          const range = document.createRange();
          range.setStart(textNode, i);
          range.setEnd(textNode, i + 1);
          if (range.getBoundingClientRect().right <= right) visibleCharacters++;
        }
        return {
          height: row.getBoundingClientRect().height,
          rowHeight: parseFloat(getComputedStyle(row).getPropertyValue("--row-h")),
          visibleCharacters,
          compact: cells.filter(cell => getComputedStyle(cell).display !== "none" && (cell.querySelector("code, time") || cell.dataset.card === "status")).map(cell => ({
            text: cell.textContent,
            clipped: (cell.firstElementChild ?? cell).scrollWidth > (cell.firstElementChild ?? cell).clientWidth,
            textHeight: textBounds(cell).height,
            lineHeight: parseFloat(getComputedStyle(cell).lineHeight),
          })),
        };
      }), longItem.title);
      for (const row of measurements) {
        expect(row.height).toBeLessThanOrEqual(row.rowHeight + 1);
        // Keep at least 40% of the 30-character subject readable beside its identities.
        expect(row.visibleCharacters).toBeGreaterThanOrEqual(12);
        for (const cell of row.compact) {
          expect(cell.clipped, `${cell.text} is not clipped`).toBe(false);
          expect(cell.textHeight, `${cell.text} stays on one line`).toBeLessThanOrEqual(cell.lineHeight + 1);
        }
      }
      const bounds = await grid.evaluate(el => {
        const card = el.closest("section")!;
        return { table: el.getBoundingClientRect().right, card: card.getBoundingClientRect().right, overflow: card.scrollWidth - card.clientWidth };
      });
      expect(bounds.table).toBeLessThanOrEqual(bounds.card + 1);
      expect(bounds.overflow).toBeLessThanOrEqual(1);
      await fits(page, "approval list");
      await page.screenshot({ path: info.outputPath(`approvals-columns-${width}-${theme}-${preview}.png`), fullPage: true });
      if (!preview) await rows.first().click();
      else await column(page).getByRole("button", { name: t("common.closePanel"), exact: true }).click();
    }
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
  await mockDocument(page, { ...item, box: "completed", status: { key: "APPLIED" }, route: item.route.map(step => ({ ...step, state: "done" })) });
  await page.goto("/approvals?box=completed");
  const row = page.getByRole("row", { name: /영업 조직 개편안/ });
  await expect(row.getByRole("gridcell", { name: "—", exact: true })).toHaveCount(0);
  await expect(row.locator('[aria-current="step"]')).toHaveCount(0);
  await row.click();
  await expect(column(page).getByRole("list", { name: "결재선", exact: true }).getByRole("listitem")).toHaveCount(item.route.length);
  await expect(column(page).locator('[aria-current="step"]')).toHaveCount(0);
});

test("an unavailable approvals module hides the rail entry and refuses a direct URL", async ({ page }) => {
  const mock = await mockScreen(page, screens[0], "empty", "not-ready");
  const queries = await mockApprovals(page);
  await page.goto("/approvals");
  await expect(page.getByRole("navigation", { name: t("shell.nav") }).getByRole("link", { name: "결재함", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "결재함", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
  await expect(page.getByText("module_disabled", { exact: true })).toBeHidden();
  await page.getByText(t("common.denied.why"), { exact: true }).click();
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
