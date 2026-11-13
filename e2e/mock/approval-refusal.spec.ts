// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

const refusals = [
  { code: "org_change.refuse.identity_unbound", message: "org_change.refuse.identity_unbound" },
  { code: "org_change.refuse.missing_grant", message: "org_change.refuse.missing_grant" },
  { code: "org_change_sod_violation", message: "requestOutcome.code.org_change_sod_violation" },
] as const;

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`read-only approval explains server refusals at ${width}px ${theme}`, async ({ page }, info) => {
    const mock = await mockScreen(page, screens[0], "empty");
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    let refusal: string | null = null;
    await page.route(url => url.pathname === "/api/v1/approvals/approval-1", route => route.fulfill({ json: {
      id: "approval-1", box: "pending", title: "조직 개편안", summary: "영업팀 통합", document_no: "AP-2026-001",
      source: { key: "org_change", label: "조직 변경" }, status: { key: "IN_APPROVAL" },
      requested_at: "2026-11-03T01:00:00Z", facts: [], route: [], body: [],
      viewer: { kind: "org_change", id: "change-1" }, revision: 1, fingerprint: "document-r1",
      consequence: "", opinion_max: 0, my_actions: { kind: "none" }, decision_refusal: refusal,
    } }));
    for (const entry of [...refusals, { code: "future_refusal", message: "approvals.viewer.blockedHint" }, { code: null, message: null }] as const) {
      refusal = entry.code;
      await page.goto("/approvals/approval-1");
      await expect(page.getByRole("heading", { level: 1, name: "조직 개편안", exact: true })).toBeVisible();
      if (entry.message) {
        const verification = page.locator("dl > div").filter({ has: page.getByRole("term").filter({ hasText: /^결재 전 확인$/ }) });
        await expect(verification).toHaveCount(1);
        await expect(verification.getByRole("definition")).toHaveText(t(entry.message));
      } else {
        await expect(page.getByRole("term").filter({ hasText: /^결재 전 확인$/ })).toHaveCount(0);
        await expect(page.getByText(t("approvals.viewer.blockedHint"), { exact: true })).toHaveCount(0);
      }
      await expect(page.getByRole("region", { name: "문서 내용", exact: true })).toContainText("영업팀 통합");
      await expect(page.getByRole("link", { name: "원본 기록 열기", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: /^의견/ })).toHaveCount(0);
      await expect(page.getByText("future_refusal", { exact: true })).toHaveCount(0);
      if (width === 390) await fits(page, "read-only approval");
      if (entry.code === refusals[0].code) {
        await page.screenshot({ path: info.outputPath(`approval-refusal-${width}-${theme}.png`), fullPage: true });
        await expectAxe(page, "read-only approval refusal");
      }
    }
    await page.goto("/_gallery?entry=approvals-page");
    await expect(page.getByText(t("org_change.refuse.identity_unbound"), { exact: true })).toBeVisible();
    expect(mock.unexpected).toEqual([]);
  });
}
