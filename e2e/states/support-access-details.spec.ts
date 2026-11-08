// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { AT, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

const session: components["schemas"]["SupportSession"] = {
  id: id(5001), operator_label: "공급사 · 지원 운영자", ticket_ref: "HELP-123", reason_code: "DIAGNOSE",
  reason: "직원 조회 화면에서 발생한 오류의 원인을 확인하고 처리 결과를 안내하기 위한 지원 요청입니다.",
  scope: ["hr_basic"], state: "OPERATOR_APPROVED", masked: true, requested_duration_seconds: 1800,
  approved_duration_seconds: null, tenant_approved_at: null, requested_at: AT, request_expires_at: AT, expires_at: null,
  decisions: [{ actor_label: "지원 운영자", decision: "OPERATOR_APPROVE", at: AT }],
  records: [],
};

for (const state of ["OPERATOR_APPROVED", "ACTIVE", "ENDED"] as const) for (const width of [390, 1440]) {
  test(`support details: ${state} reflow at ${width}px @ui-state`, async ({ page }, info) => {
    const fixture = await mockScreen(page, screens[0], "empty");
    const next = { ...session, id: id(5003), ticket_ref: "HELP-456", requested_duration_seconds: 900 };
    const current = state === "OPERATOR_APPROVED" ? session : {
      ...session, state, approved_duration_seconds: session.requested_duration_seconds, tenant_approved_at: AT,
      expires_at: "2026-10-26T09:30:00Z",
      decisions: [...session.decisions, { actor_label: "고객 승인자", decision: "APPROVE", at: AT }],
      records: [{ id: id(5002), method: "GET", path: "/api/v1/employees", at: AT }],
    };
    await mockRoute(page, "get", "/api/v1/support-sessions", { status: 200, json: {
      can_approve: true, sessions: [current, next],
    } });
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/audit/support-access");
    const main = page.getByRole("main");
    const grid = main.getByRole("grid", { name: "지원 접근", exact: true });
    await expect(grid).toBeVisible();
    // Selecting a row must leave its form in the page flow, outside the grid's scroll area.
    const row = grid.getByRole("row").filter({ hasText: session.operator_label }).filter({ hasText: session.ticket_ref });
    await row.focus();
    await row.press("Enter");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(grid.getByRole("spinbutton")).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "요청·승인·종료 기록", level: 2 })).toBeVisible();
    await expect(main.getByRole("heading", { name: "접속기록 · 공급사", level: 2 })).toBeVisible();
    const approve = main.getByRole("button", { name: "지원 접근 승인", exact: true });
    const end = main.getByRole("button", { name: "지원 종료", exact: true });
    await expect(approve).toHaveCount(state === "OPERATOR_APPROVED" ? 1 : 0);
    await expect(end).toHaveCount(state === "ACTIVE" ? 1 : 0);
    if (state === "OPERATOR_APPROVED") {
      await row.press("Tab");
      await expect(main.getByRole("spinbutton")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(main.getByRole("checkbox")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(approve).toBeFocused();
    }
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      for (const control of await main.getByRole("spinbutton").or(main.getByRole("checkbox")).or(main.getByRole("button")).all()) {
        const bounds = await control.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      await fits(page, `support details/${state}/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`support-details-${state}-${width}-${theme}.png`), fullPage: true });
    }
    await expectAxe(page, `support details/${state}/${width}`);
    if (state === "OPERATOR_APPROVED") {
      await main.getByRole("spinbutton").fill("10");
      await main.getByRole("checkbox").check();
    }
    await row.focus();
    await row.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(grid.getByRole("row").filter({ hasText: next.operator_label }).filter({ hasText: next.ticket_ref })).toHaveAttribute("aria-selected", "true");
    await expect(main.getByRole("spinbutton")).toHaveValue("15");
    await expect(main.getByRole("checkbox")).not.toBeChecked();
    await expect(approve).toHaveCount(1);
    await expect(end).toHaveCount(0);
    await expect(grid.getByRole("spinbutton")).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}
