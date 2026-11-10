// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure } from "./fixtures";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

const item = (n: number) => ({
  id: `approval-${n}`, box: "pending", title: `조직 개편안 ${n}`, summary: "영업1팀과 영업2팀을 하나의 조직으로 합칩니다.", document_no: `AP-2026-00${n}`,
  source: { key: "org_change", label: "조직 변경" }, status: { key: "IN_APPROVAL" },
  requester: { id: "account-1", name: "김기안", role: "인사팀" }, requested_at: "2026-11-03T01:00:00Z", due_at: null, facts: [],
  route: [{ id: "first", role_key: "hr", assignee: "김기안", state: "done" }, { id: "approve", role_key: "legal", assignee: "박결재", state: "current" }],
  viewer: { kind: "org_change", id: `change-${n}` },
});
const items = [item(1), item(2), item(3)];
const column = (page: Page) => page.getByRole("complementary", { name: t("approvals.document.title"), exact: true });

/** The list read plus the per-document read the column makes; `document` picks the reply for one id. */
async function mock(page: Page, document: (id: string) => { status: number; json: object } | undefined = () => undefined) {
  const screen = await mockScreen(page, screens[0], "empty");
  await page.route(url => url.pathname === "/api/v1/approvals", route => route.fulfill({ json: {
    items, focused: null, next_cursor: null, sources: [], counts: { pending: 3, upcoming: 0, requested: 0, reference: 0, completed: 0 },
  } }));
  await page.route(url => /^\/api\/v1\/approvals\/[^/]+$/.test(url.pathname), route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    const found = items.find(entry => entry.id === id);
    return route.fulfill(document(id) ?? (found
      ? { status: 200, json: { ...found, body: [{ key: "change", label: "변경 내용", value: "영업팀으로 통합" }], revision: 1, fingerprint: `sha256:${id}-r1`, consequence: "승인하면 시행일에 반영됩니다.", opinion_max: 1000, my_actions: { kind: "none" } } }
      : { status: 404, json: failure("not_found") }));
  });
  return screen;
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
  await expectAxe(page, `approval document column ${theme}`);
  await page.screenshot({ path: info.outputPath(`approvals-column-1440-${theme}.png`), fullPage: true });

  await row(1).focus();
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/sel=approval-2/);
  await expect(column(page).getByRole("heading", { name: "조직 개편안 2", exact: true })).toBeVisible();
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
