// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { AT, failure, id } from "../mock/fixtures";
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
    const panel = page.getByRole("complementary", { name: session.ticket_ref, exact: true });
    await expect(main.getByRole("complementary")).toHaveCount(0);
    await expect(page.locator("#route-heading")).toBeFocused();
    // Selecting a row opens the house panel outside the grid's scroll area.
    const row = grid.getByRole("row").filter({ hasText: session.operator_label }).filter({ hasText: session.ticket_ref });
    await row.focus();
    await row.press("Enter");
    await expect(page.locator(`[data-id="${current.id}"]`)).toHaveAttribute("aria-selected", "true");
    await expect(grid.getByRole("spinbutton")).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: "요청·승인·종료 기록", level: 3 })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "접속기록 · 공급사", level: 3 })).toBeVisible();
    const approve = page.getByRole("button", { name: "지원 접근 승인", exact: true });
    const end = page.getByRole("button", { name: "지원 종료", exact: true });
    await expect(approve).toHaveCount(state === "OPERATOR_APPROVED" ? 1 : 0);
    await expect(end).toHaveCount(state === "ACTIVE" ? 1 : 0);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      for (const control of await panel.getByRole("spinbutton").or(panel.getByRole("checkbox")).or(panel.getByRole("button")).all()) {
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
      await approve.click();
      const sheet = page.getByRole("dialog");
      const commit = sheet.getByRole("button", { name: "지원 접근 승인", exact: true });
      await page.getByRole("spinbutton").fill("31");
      await commit.click();
      await expect(page.getByRole("spinbutton")).toHaveAttribute("aria-invalid", "true");
      expect(decisions).toEqual([]);
      await page.getByRole("spinbutton").fill("10");
      await page.getByRole("checkbox").check();
      await commit.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => decisions).toEqual([{ decision: "APPROVE", approved_duration_seconds: 600, reveal_classes: ["personal"] }]);
    }
    const close = panel.getByRole("button", { name: width === 390 ? "돌아가기" : "상세 패널 닫기", exact: true });
    await close.click();
    await row.focus();
    await row.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-id="${next.id}"]`)).toHaveAttribute("aria-selected", "true");
    await approve.click();
    await expect(page.getByRole("spinbutton")).toHaveValue("15");
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByRole("dialog").getByRole("button", { name: "지원 접근 승인", exact: true })).toBeInViewport({ ratio: 1 });
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
      can_approve: true, sessions: state === "ACTIVE" ? [{ id: current.id, operator_label: current.operator_label, expires_at: current.expires_at }] : [],
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
    const action = page.getByRole("button", { name: state === "ACTIVE" ? "지원 종료" : "지원 접근 승인", exact: true });
    if (entry === "plain") {
      const grid = main.getByRole("grid", { name: "지원 접근", exact: true });
      await expect(grid).toBeVisible();
      await expect(main.getByRole("complementary")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("#route-heading")).toBeFocused();
      await expect(main.getByRole("grid", { name: "지원 접근", exact: true }).getByRole("row").nth(1)).toBeInViewport({ ratio: 1 });
      fixture.release();
      return;
    }
    // Assert before any focus, click, or screenshot can scroll the target into view.
    await expect(action).toBeInViewport({ ratio: 1 });
    const panel = page.getByRole("complementary", { name: current.ticket_ref, exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(current.reason, { exact: false })).toBeInViewport();
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await expect(action).toBeInViewport({ ratio: 1 });
      await fits(page, `support details/${entry}/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`support-${entry}-${state}-${width}-${theme}.png`) });
    }
    await expectAxe(page, `support details/${entry}/${state}/${width}`);
    await page.keyboard.press("Escape");
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

for (const width of [390, 1440]) test(`ended support history stays a list on plain navigation at ${width}px @ui-state`, async ({ page }, info) => {
  const fixture = await mockScreen(page, screens.find(screen => screen.key === "home")!, "empty");
  await mockRoute(page, "get", "/api/v1/support-sessions/active", { status: 200, json: { can_approve: true, sessions: [], pending_count: 0, pending_approvals: [] } });
  const sessions = Array.from({ length: 25 }, (_, index) => ({ ...session, id: id(5200 + index), ticket_ref: `HELP-${1000 + index}`, state: "ENDED" }));
  await mockRoute(page, "get", "/api/v1/support-sessions", { status: 200, json: { can_approve: true, sessions } });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  if (width === 390) await page.getByRole("button", { name: "메뉴", exact: true }).click();
  await page.getByRole("navigation").getByRole("link", { name: "감사 기록", exact: true }).click();
  await expect(page.getByRole("grid", { name: "지원 접근", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: sessions[0]!.ticket_ref })).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#route-heading")).toBeFocused();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await fits(page, `support history/${width}/${theme}`);
    await page.screenshot({ path: info.outputPath(`support-history-${width}-${theme}.png`) });
  }
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});

for (const width of [390, 1440]) for (const command of ["approve", "deny", "end"] as const) for (const refresh of [false, true]) test(`support ${command} refusal stays visible at ${width}px${refresh ? " after refresh" : ""} @ui-state`, async ({ page }, info) => {
  const fixture = await mockScreen(page, screens.find(screen => screen.key === "home")!, "empty");
  const current = command === "end" ? { ...session, state: "ACTIVE", tenant_approved_at: AT } : session;
  let refused = false;
  await mockRoute(page, "get", "/api/v1/support-sessions", () => ({ status: 200, json: {
    can_approve: true, sessions: [{ ...current, state: refresh && refused ? (command === "end" ? "ENDED" : "EXPIRED") : current.state }],
  } }));
  await page.route(`**/api/v1/support-sessions/${session.id}/${command === "end" ? "end" : "decision"}`, route => {
    refused = true;
    return route.fulfill({ status: 409, json: failure(command === "end" ? "support.refuse.session_ended" : "support.refuse.request_expired") });
  });
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/audit/support-access?review=${session.id}`);
  await page.getByRole("complementary").getByRole("button", { name: command === "end" ? "지원 종료" : "지원 접근 승인", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: session.ticket_ref, exact: true });
  await expect(sheet).toBeVisible();
  const action = sheet.getByRole("button", { name: command === "end" ? "지원 종료" : command === "deny" ? "지원 접근 반려" : "지원 접근 승인", exact: true });
  await expect(action).toBeInViewport({ ratio: 1 });
  await action.click();
  if (refresh) {
    await expect(page.getByRole("complementary", { name: session.ticket_ref, exact: true })).toBeVisible();
    await expect(action).toHaveCount(0);
  } else await expect(action).toBeEnabled();
  const alert = page.getByRole("alert");
  await expect(alert).toBeInViewport({ ratio: 1 });
  await expect(alert.locator("..")).toBeFocused();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await expect(alert).toBeInViewport({ ratio: 1 });
    await fits(page, `support refusal/${command}/${width}/${theme}`);
    await page.screenshot({ path: info.outputPath(`support-refusal-${command}-${width}-${theme}.png`) });
  }
  await expectAxe(page, `support refusal/${command}/${width}`);
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});

for (const width of [390, 1440]) test(`support indicator fits the header at ${width}px @ui-state`, async ({ page }, info) => {
  const fixture = await mockScreen(page, screens.find(screen => screen.key === "home")!, "empty");
  await mockRoute(page, "get", "/api/v1/support-sessions/active", { status: 200, json: { can_approve: true, sessions: [{ id: session.id, operator_label: session.operator_label, expires_at: AT }], pending_count: 1, pending_approvals: [session] } });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  const indicator = page.getByRole("link", { name: /공급사 지원 접근 · 승인 대기/ });
  if (width === 390) {
    await expect(indicator.locator("svg")).toBeVisible();
    await expect(indicator.getByText("2", { exact: true })).toHaveCount(0);
  } else await expect(indicator.getByText("지원 2", { exact: true })).toBeVisible();
  await expect(indicator).toBeInViewport({ ratio: 1 });
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeInViewport({ ratio: 1 });
    await fits(page, `support indicator/${width}/${theme}`);
    await page.screenshot({ path: info.outputPath(`support-header-${width}-${theme}.png`) });
  }
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});

for (const width of [390, 1440]) for (const command of ["approve", "deny", "end"] as const) test(`support ${command} success returns a receipt to the peek at ${width}px @ui-state`, async ({ page }, info) => {
  const fixture = await mockScreen(page, screens.find(screen => screen.key === "home")!, "empty");
  let saved = false;
  const current = command === "end" ? { ...session, state: "ACTIVE", tenant_approved_at: AT } : session;
  await mockRoute(page, "get", "/api/v1/support-sessions", () => ({ status: 200, json: {
    can_approve: true, sessions: [saved ? { ...current, state: command === "end" ? "ENDED" : command === "deny" ? "DENIED" : "OPERATOR_APPROVED", tenant_approved_at: AT } : current],
  } }));
  await mockRoute(page, "post", `/api/v1/support-sessions/{id}/${command === "end" ? "end" : "decision"}`, () => {
    saved = true;
    return { status: 200, json: { id: session.id, decision: command === "deny" ? "DENY" : "APPROVE" } };
  });
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/audit/support-access?review=${session.id}`);
  const panel = page.getByRole("complementary", { name: session.ticket_ref, exact: true });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.getByRole("spinbutton")).toHaveCount(0);
  await panel.getByRole("button", { name: command === "end" ? "지원 종료" : "지원 접근 승인", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: session.ticket_ref, exact: true });
  await sheet.getByRole("button", { name: command === "end" ? "지원 종료" : command === "deny" ? "지원 접근 반려" : "지원 접근 승인", exact: true }).click();
  await expect.poll(() => saved).toBe(true);
  await expect(sheet).toHaveCount(0);
  await expect(panel.getByText(command === "end" ? "지원을 종료했습니다. 다음 요청부터 접근이 거절됩니다." : "지원 접근 결정을 기록했습니다.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    await fits(page, `support receipt/${command}/${width}/${theme}`);
    await page.screenshot({ path: info.outputPath(`support-receipt-${command}-${width}-${theme}.png`) });
  }
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});
