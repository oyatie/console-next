// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { expectAccessible, fits } from "../a11y";
import { experienceState, seededDateStyle } from "../experience";
import { recordShifts } from "../stability";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

const TITLE = "영업 조직 개편안";

async function openDocument(page: Page) {
  const mock = await mockScreen(page, screens[0], "empty");
  await page.route(url => decodeURIComponent(url.pathname) === "/api/v1/approvals/org_change:document", route => route.fulfill({ json: {
    id: "org_change:document", box: "requested", title: TITLE, summary: "고객 지원 체계 개선", document_no: "OC-2026-0001",
    source: { key: "org_change", label: "조직 변경" }, status: { key: "IN_APPROVAL" },
    requester: { id: "requester", name: "김기안" }, requested_at: "2026-11-03T01:00:00Z",
    facts: [], effective_date: "2026-12-01",
    route: [{ id: "step", role_key: "hr", assignee: "", state: "current" }],
    viewer: { kind: "org_change", id: "document" },
    body: [],
    proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: "workplace", name: "고객지원부" }],
    proposal_names: { workplace: "본점" }, revision: 1, fingerprint: "source-version", consequence: "", opinion_max: 0, my_actions: { kind: "none" },
  } }));
  await page.goto("/approvals/org_change:document");
  return mock;
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`canonical approval document at ${width}px ${theme}`, async ({ page, storageState }, info) => {
    const style = seededDateStyle(storageState);
    await page.addInitScript(recordShifts);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await openDocument(page);
    await expect(page.getByRole("main").getByRole("heading", { name: TITLE, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "결재선", exact: true })).toContainText("인사");
    await expect(page.locator("main")).toContainText("결재 중");
    // Classic sets the proposal in the document's body; Console gives it its own numbered section.
    const content = page.getByRole("region", { name: t("approvals.viewer.body"), exact: true }).or(page.getByRole("region", { name: t("approvals.field.proposal"), exact: true }));
    await expect(content).toContainText("고객지원부");
    await expect(content).toContainText("본점");
    await expect(page.getByRole("region", { name: "문서 정보", exact: true })).toContainText(fmtDate("2026-12-01", { style }));
    if (style !== "iso") await expect(page.locator("main")).not.toContainText("2026-12-01");
    await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "원본 기록 열기", exact: true })).toHaveAttribute("href", "/org/changes/document");
    await fits(page, "canonical approval document");
    await expectAccessible(page, "canonical approval document");
    await page.screenshot({ path: info.outputPath("document.png"), fullPage: true });
    expect(mock.unexpected).toEqual([]);
  });
}

// Classic titles the page with the document; Console titles it with the module and gives the document an h2, as the
// approval board draws it.
for (const width of [1440, 390]) test(`Classic titles the approval page with the document at ${width}px`, { tag: "@baseline" }, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openDocument(page);
  await expect(page.getByRole("heading", { level: 1, name: TITLE, exact: true })).toBeVisible();
});

test.describe("console look", () => {
  test.use({ storageState: experienceState("console") });
  for (const width of [1440, 390]) test(`Console titles the approval page with the module and the document as its h2 at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openDocument(page);
    await expect(page.getByRole("heading", { level: 1, name: t("approvals.console.title"), exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: TITLE, exact: true })).toBeVisible();
  });
});
