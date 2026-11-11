// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { failure } from "./fixtures";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const item = (n: number) => ({
  id: `approval-${n}`, box: "pending", title: `조직 개편안 ${n}`, summary: "영업1팀과 영업2팀을 하나의 조직으로 합칩니다.", document_no: `AP-2026-00${n}`,
  source: { key: "org_change", label: "조직 변경" }, status: { key: "IN_APPROVAL" },
  requester: { id: "account-1", name: "김기안", role: "인사팀" }, requested_at: "2026-11-03T01:00:00Z", due_at: null, facts: [], effective_date: n === 2 ? null : "2026-11-20",
  route: [{ id: "first", role_key: "hr", assignee: "김기안", state: "done" }, { id: "approve", role_key: "legal", assignee: "박결재", state: "current" }],
  viewer: { kind: "org_change", id: `change-${n}` },
});
const items = [item(1), item(2), item(3)];
const column = (page: Page) => page.getByRole("complementary", { name: t("approvals.document.title"), exact: true });

/** The list read plus the per-document read the column makes; `document` picks the reply for one id. */
async function mock(page: Page, document: (id: string) => { status: number; json: object } | undefined = () => undefined) {
  const screen = await mockScreen(page, screens[0], "empty");
  const reads = { list: 0 };
  await page.route(url => url.pathname === "/api/v1/approvals", route => {
    reads.list++;
    return route.fulfill({ json: { items, focused: null, next_cursor: null, sources: [], counts: { pending: 3, upcoming: 0, requested: 0, reference: 0, completed: 0 } } });
  });
  await page.route(url => /^\/api\/v1\/approvals\/[^/]+$/.test(url.pathname), route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    // approval-9 exists but is not on the loaded list page.
    const found = [...items, item(9)].find(entry => entry.id === id);
    return route.fulfill(document(id) ?? (found
      ? { status: 200, json: { ...found, body: [{ key: "change", label: "변경 내용", value: "영업팀으로 통합" }], revision: 1, fingerprint: `sha256:${id}-r1`, consequence: "승인하면 시행일에 반영됩니다.", opinion_max: 1000, my_actions: { kind: "none" } } }
      : { status: 404, json: failure("not_found") }));
  });
  return Object.assign(screen, { reads });
}

for (const theme of ["light", "dark"]) test(`the document opens beside the list, follows J/K and survives a reload (${theme})`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  const screen = await mock(page);
  await page.goto("/approvals");
  const row = (n: number) => page.getByRole("row", { name: new RegExp(`조직 개편안 ${n}`) });
  await row(1).click();
  await expect(page).toHaveURL(/sel=approval-1/);
  await expect(column(page).getByRole("heading", { name: "조직 개편안 1", exact: true })).toBeVisible();
  // Same order as the full page: the 결재선 first, then the document.
  const chain = column(page).getByRole("region", { name: t("approvals.preview.route"), exact: true });
  const body = column(page).getByRole("region", { name: t("approvals.viewer.body"), exact: true });
  expect((await chain.boundingBox())!.y).toBeLessThan((await body.boundingBox())!.y);
  await expect(row(1)).toBeVisible();
  // A row says when its document takes effect, beside the title; a document with no date says nothing.
  await expect(row(1)).toContainText(`조직 개편안 1 · ${t("approvals.row.effective", { date: fmtDate("2026-11-20") })}`);
  await expect(row(2).getByText(t("approvals.row.effective", { date: "" }).trim())).toHaveCount(0);
  await expectAxe(page, `approval document column ${theme}`);
  await page.screenshot({ path: info.outputPath(`approvals-column-1440-${theme}.png`), fullPage: true });

  const listReads = screen.reads.list;
  await row(1).focus();
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/sel=approval-2/);
  await expect(column(page).getByRole("heading", { name: "조직 개편안 2", exact: true })).toBeVisible();
  await expect(column(page).getByRole("link", { name: t("approvals.openSource"), exact: true })).toHaveAttribute("href", "/org/changes/change-2");
  expect(screen.reads.list, "selecting a document leaves the list as it is").toBe(listReads);
  await page.keyboard.press("k");
  await expect(page).toHaveURL(/sel=approval-1/);

  await page.reload();
  await expect(column(page).getByRole("heading", { name: "조직 개편안 1", exact: true })).toBeVisible();

  await row(1).focus();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: t("approvals.filters.search"), exact: true })).toBeFocused();
  await row(1).focus();
  await page.keyboard.press("Escape");
  await expect(column(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/sel=/);
  await expect(row(1)).toBeFocused();
  expect(screen.unexpected).toEqual([]);
});

test("a link saved with the old focus parameter opens the same document", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mock(page);
  await page.goto("/approvals?focus=approval-2");
  await expect(column(page).getByRole("heading", { name: "조직 개편안 2", exact: true })).toBeVisible();
});

test("a shared link opens a document the loaded list does not hold", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mock(page);
  await page.goto("/approvals?sel=approval-9");
  await expect(column(page).getByRole("heading", { name: "조직 개편안 9", exact: true })).toBeVisible();
  await expect(column(page).getByText("AP-2026-009", { exact: true }).first()).toBeVisible();
  await expect(column(page).getByRole("link", { name: t("approvals.openSource"), exact: true })).toHaveAttribute("href", "/org/changes/change-9");
});

test("the decision panel works in the column and an open reason form keeps Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const reason = { codes: [{ code: "POLICY", label: "정책에 맞지 않음" }, { code: "OTHER", label: "기타" }], other: "OTHER", memo_max: 1000 };
  await mock(page, id => ({ status: 200, json: { ...item(Number(id.split("-")[1])), body: [], revision: 1, fingerprint: `sha256:${id}-r1`, consequence: "승인하면 시행일에 반영됩니다.", opinion_max: 1000,
    my_actions: { kind: "approve", return: { consequence: "기안자에게 돌아갑니다.", reason }, reject: { consequence: "문서가 종결됩니다.", reason } } } }));
  await page.goto("/approvals?sel=approval-1");
  const approve = column(page).getByRole("button", { name: "승인", exact: true });
  await expect(approve).toBeVisible();
  // 승인 is the one filled button; 반려 and 보완 요청 stay secondary.
  await expect(column(page).locator(".btn--primary")).toHaveCount(1);
  await expect(approve).toHaveClass(/btn--primary/);
  const opinion = column(page).getByRole("textbox", { name: /^의견/ });
  await opinion.fill("검토 의견");
  await column(page).getByRole("button", { name: "반려", exact: true }).click();
  const radio = column(page).getByRole("radio", { name: "정책에 맞지 않음", exact: true });
  await radio.focus();
  await page.keyboard.press("Escape");
  await expect(column(page).getByRole("radio")).toHaveCount(0);
  await expect(column(page)).toBeVisible();
  await expect(opinion).toHaveValue("검토 의견");
  await expect(column(page).getByRole("button", { name: "반려", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(column(page)).toHaveCount(0);
});

for (const theme of ["light", "dark"]) test(`at phone width the document replaces the list and goes back (${theme})`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  await mock(page);
  await page.goto("/approvals?sel=approval-1");
  await expect(column(page).getByRole("region", { name: t("approvals.preview.route"), exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /조직 개편안 2/ })).toBeHidden();
  await fits(page, "approval document column");
  await expectAxe(page, `approval document column 390px ${theme}`);
  await page.screenshot({ path: info.outputPath(`approvals-column-390-${theme}.png`), fullPage: true });
  await column(page).getByRole("button", { name: t("common.back"), exact: true }).click();
  await expect(column(page)).toHaveCount(0);
  await expect(page.getByRole("row", { name: /조직 개편안 2/ })).toBeVisible();
});

for (const [name, status, code] of [["missing", 404, "not_found"], ["failed", 503, "service_unavailable"], ["refused", 403, "forbidden"]] as const) {
  test(`a ${name} document is reported inside the column and the list stays`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mock(page, () => ({ status, json: failure(code) }));
    await page.goto("/approvals?sel=approval-1");
    const title = name === "missing" ? t("common.read.notFound.title") : name === "failed" ? t("common.loadFailed.title") : t("common.denied.panel");
    await expect(column(page).getByText(title, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("row", { name: /조직 개편안 2/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
  });
}
