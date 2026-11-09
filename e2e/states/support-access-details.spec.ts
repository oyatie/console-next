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
    const fixture = await mockScreen(page, screens.find((screen) => screen.key === "home")!, "empty");
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
    const panel = main.getByRole("complementary", { name: session.ticket_ref, exact: true });
    await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
    // Selecting a row opens the house panel outside the grid's scroll area.
    const row = grid.getByRole("row").filter({ hasText: session.operator_label }).filter({ hasText: session.ticket_ref });
    await row.focus();
    await row.press("Enter");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(grid.getByRole("spinbutton")).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "요청·승인·종료 기록", level: 3 })).toBeVisible();
    await expect(main.getByRole("heading", { name: "접속기록 · 공급사", level: 3 })).toBeVisible();
    const approve = main.getByRole("button", { name: "지원 접근 승인", exact: true });
    const end = main.getByRole("button", { name: "지원 종료", exact: true });
    await expect(approve).toHaveCount(state === "OPERATOR_APPROVED" ? 1 : 0);
    await expect(end).toHaveCount(state === "ACTIVE" ? 1 : 0);
    if (state === "OPERATOR_APPROVED") {
      await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
      await page.keyboard.press("Tab");
      if (width === 1440) await page.keyboard.press("Tab");
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
      const decisions: unknown[] = [];
      await mockRoute(page, "post", "/api/v1/support-sessions/{id}/decision", request => {
        decisions.push(request.postDataJSON());
        return { status: 200, json: { id: current.id, decision: "APPROVE" } };
      });
      await main.getByRole("spinbutton").fill("31");
      await approve.click();
      await expect(main.getByRole("spinbutton")).toHaveAttribute("aria-invalid", "true");
      expect(decisions).toEqual([]);
      await main.getByRole("spinbutton").fill("10");
      await main.getByRole("checkbox").check();
      await approve.click();
      await expect.poll(() => decisions).toEqual([{ decision: "APPROVE", approved_duration_seconds: 600, reveal_classes: ["personal"] }]);
    }
    await row.focus();
    await row.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(grid.getByRole("row").filter({ hasText: next.operator_label }).filter({ hasText: next.ticket_ref })).toHaveAttribute("aria-selected", "true");
    await expect(main.getByRole("spinbutton")).toHaveValue("15");
    await expect(main.getByRole("checkbox")).not.toBeChecked();
    await expect(approve).toHaveCount(1);
    await expect(approve).toBeInViewport({ ratio: 1 });
    await expect(end).toHaveCount(0);
    await expect(grid.getByRole("spinbutton")).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}

for (const width of [390, 1440]) for (const state of ["OPERATOR_APPROVED", "ACTIVE"] as const) {
  const entries = [state === "ACTIVE" ? "banner" : "review", "indicator", "direct", "plain"];
  for (const entry of entries) test(`support details: ${state} via ${entry} among 25 sessions at ${width}px @ui-state`, async ({ page }, info) => {
    const fixture = await mockScreen(page, screens.find((screen) => screen.key === "home")!, "empty");
    const current = { ...session, state, tenant_approved_at: state === "ACTIVE" ? AT : null };
    const history = Array.from({ length: 24 }, (_, index) => ({
      ...session, id: id(5100 + index), ticket_ref: `HELP-${index + 200}`, state: "ENDED",
    }));
    await mockRoute(page, "get", "/api/v1/support-sessions", { status: 200, json: {
      can_approve: true, sessions: entry === "plain" ? [current, ...history] : [...history, current],
    } });
    await mockRoute(page, "get", "/api/v1/support-sessions/active", { status: 200, json: {
      can_approve: true, sessions: state === "ACTIVE" ? [current] : [],
      pending_count: state === "ACTIVE" ? 0 : 1, pending_approvals: state === "ACTIVE" ? [] : [current],
    } });
    await page.setViewportSize({ width, height: 844 });
    if (entry === "direct" || entry === "plain") {
      await page.goto(`/audit/support-access${entry === "direct" ? `?review=${current.id}` : ""}`);
    } else {
      await page.goto("/");
      const name = entry === "indicator" ? /공급사 지원 접근 · 승인 대기/ : entry === "banner" ? "지원 기록 확인 · 종료" : "지원 요청 확인";
      await page.getByRole("link", { name, exact: typeof name === "string" }).click();
    }
    const main = page.getByRole("main");
    const action = main.getByRole("button", { name: state === "ACTIVE" ? "지원 종료" : "지원 접근 승인", exact: true });
    // Assert before any focus, click, or screenshot can scroll the target into view.
    await expect(action).toBeInViewport({ ratio: 1 });
    const panel = main.getByRole("complementary", { name: current.ticket_ref, exact: true });
    await expect(panel.getByRole("heading", { name: current.ticket_ref, level: 2 })).toBeFocused();
    await expect(panel.getByText(current.reason, { exact: false })).toBeInViewport();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await expect(action).toBeInViewport({ ratio: 1 });
      await fits(page, `support details/${entry}/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`support-${entry}-${state}-${width}-${theme}.png`) });
    }
    await expectAxe(page, `support details/${entry}/${state}/${width}`);
    await panel.getByRole("heading", { level: 2 }).press("Escape");
    await expect(panel).toHaveCount(0);
    const grid = main.getByRole("grid", { name: "지원 접근", exact: true });
    const ended = grid.getByRole("row").filter({ hasText: history[0]!.ticket_ref });
    await ended.focus();
    await ended.press("Enter");
    const endedPanel = main.getByRole("complementary", { name: history[0]!.ticket_ref, exact: true });
    await expect(endedPanel.getByRole("heading", { level: 2 })).toBeFocused();
    await expect(action).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(ended).toBeFocused();
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
}

test("an unknown support review does not open a different session @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens.find((screen) => screen.key === "home")!, "empty");
  await mockRoute(page, "get", "/api/v1/support-sessions", { status: 200, json: { can_approve: true, sessions: [session] } });
  await page.goto(`/audit/support-access?review=${id(5999)}`);
  await expect(page.getByRole("grid", { name: "지원 접근", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("complementary")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "지원 접근 승인", exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});
