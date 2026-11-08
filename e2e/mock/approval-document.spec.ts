// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible, fits } from "../a11y";
import { recordShifts } from "../stability";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`canonical approval document at ${width}px ${theme}`, async ({ page }, info) => {
    await page.addInitScript(recordShifts);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const mock = await mockScreen(page, screens[0], "empty");
    await page.route(url => decodeURIComponent(url.pathname) === "/api/v1/approvals/org_change:document", route => route.fulfill({ json: {
      id: "org_change:document", box: "requested", title: "영업 조직 개편안", summary: "고객 지원 체계 개선", document_no: "OC-2026-0001",
      source: { key: "org_change", label: "조직 변경" }, status: { key: "IN_APPROVAL" },
      requester: { id: "requester", name: "김기안" }, requested_at: "2026-11-03T01:00:00Z",
      facts: [{ key: "effective_date", label: "시행일", value: "2026-12-01" }],
      route: [{ id: "step", role_key: "hr", assignee: "", state: "current" }],
      viewer: { kind: "org_change", id: "document" },
      body: [{ key: "target", label: "대상", value: "영업 조직" }, { key: "reason", label: "사유", value: "고객 지원 체계 개선" }],
      revision: 1, fingerprint: "source-version", consequence: "", opinion_max: 0, my_actions: { kind: "none" },
    } }));
    await page.goto("/approvals/org_change:document");
    await expect(page.getByRole("heading", { level: 1, name: "영업 조직 개편안", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "결재선", exact: true })).toContainText("인사");
    await expect(page.getByRole("region", { name: "문서 내용", exact: true })).toContainText("영업 조직");
    await expect(page.locator("main")).toContainText("결재 중");
    await expect(page.getByRole("button", { name: /승인|반려|보완 요청/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "원본 기록 열기", exact: true })).toHaveAttribute("href", "/org/changes/document");
    await fits(page, "canonical approval document");
    await expectAccessible(page, "canonical approval document");
    await page.screenshot({ path: info.outputPath("document.png"), fullPage: true });
    expect(mock.unexpected).toEqual([]);
  });
}
