// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { startOperations, tenantInSetup } from "./setup-flows";

test("Inbox ranks deadline rows before undated work and keeps a refused action with its reason", { tag: "@hr" }, async ({ browser }, info) => {
  const { admin } = await tenantInSetup(browser, "homebuckets", "업무함기한상사");
  await startOperations(admin);
  type Item = components["schemas"]["ActionInboxItem"];
  const item = (id: string, extra: Partial<Item> = {}): Item => ({
    id, kind: "register_review", title: id, ref: "", lane: "turn", urg: "wait", dueTone: "neutral",
    days_remaining: null, done: false, links: [], ...extra,
  });
  const items = [
    ...Array.from({ length: 16 }, (_, i) => item(`명부 확인 ${i + 1}`)),
    item("첫 신고", { kind: "insurance_filing", fold_key: "insurance:person:case", links: [{ kind: "statutory", id: "event" }], context: { insurance: { insurer: "EI", kind: "ACQUIRE", effective_date: "2026-10-26" } } }),
    item("둘째 신고", { kind: "insurance_filing", fold_key: "insurance:person:case", links: [{ kind: "statutory", id: "event" }], context: { insurance: { insurer: "NPS", kind: "ACQUIRE", effective_date: "2026-10-26" } } }),
    item("이후 업무", { due: "2026-11-03T00:00:00Z", days_remaining: 8 }),
    item("이번 주 업무", { due: "2026-10-29T00:00:00Z", days_remaining: 3, dueTone: "warn" }),
    item("오늘 퇴직", { kind: "hr_exit_confirm", due: "2026-10-26T00:00:00Z", days_remaining: 0, dueTone: "danger", links: [{ kind: "exit_case", id: "exit" }] }),
    item("지난 기한 업무", { due: "2026-10-25T00:00:00Z", days_remaining: -1, dueTone: "danger" }),
    item("부여 확인 대상", { kind: "grant_notice", links: [{ kind: "access", id: "refused-grant" }], context: { grants: [{
      grant_id: "refused-grant", role_id: "role", role_name_ko: "업무함 검토자", domain: "hr_basic", level: "view",
      scope: { kind: "TENANT", node_id: null, include_descendants: true }, valid_from: "2026-01-01T00:00:00Z",
      valid_to: null, enforcement: "ENFORCED", caveats: [],
    }] } }),
  ];
  await admin.route(/\/api\/v1\/me\/action-inbox(\?|$)/, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const body = await response.json() as components["schemas"]["ActionInboxResponse"];
    await route.fulfill({ response, json: { ...body, items, setup: undefined, has_work: true, next_cursor: null, total: items.length, total_is_exact: true, counts: { turn: { total: items.length, total_is_exact: true } } } });
  });
  let refusedWrites = 0;
  await admin.route("**/api/v1/access/grants/refused-grant/notice", route => {
    refusedWrites++;
    return route.fulfill({ status: 403, contentType: "application/json", json: { error: { code: "grant_notice_not_holder", message: "forbidden" } } });
  });
  await admin.setViewportSize({ width: 1440, height: 900 });
  await admin.goto("/inbox");
  const queue = admin.getByRole("region", { name: "업무함", exact: true });
  await expect(queue.getByRole("table")).toHaveCount(4);
  await expect(queue.getByRole("heading", { level: 3 })).toHaveText(["기한 지남", "기한 임박", "그 뒤", "기한 없음"]);
  const rows = queue.locator("[data-id]");
  await expect(rows.nth(0)).toContainText("지난 기한 업무");
  await expect(rows.nth(1)).toContainText("오늘 퇴직");
  await expect(rows.nth(2)).toContainText("이번 주 업무");
  await expect(rows.nth(3)).toContainText("이후 업무");
  await expect(queue.locator("tbody .btn--primary")).toHaveCount(0);
  const fold = queue.getByRole("button", { name: "4대보험 신고 · 2건", exact: true });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(queue.getByRole("link", { name: "4대보험 신고 열기", exact: true })).toHaveCount(2);
  await fold.click();
  await admin.locator("main").evaluate(el => { el.scrollTop = 0; });
  const walk = async (width: number) => {
    await expect(queue.getByRole("table", { name: "기한 임박", exact: true }).getByRole("row").last()).toBeInViewport();
    await expect(queue.getByText("오늘 퇴직", { exact: true })).toHaveCount(1);
    await expect(queue.getByRole("button", { name: "명부 확인 1 작업", exact: true })).toHaveCount(0);
    await expectAccessible(admin, `Home deadline groups at ${width}px`);
    for (const theme of ["light", "dark"]) {
      await admin.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      expect(await rows.evaluateAll(elements => elements.flatMap(row => {
        const box = row.getBoundingClientRect();
        return [...row.querySelectorAll('[role="cell"], td')].filter(cell => cell.closest("[data-id]") === row && getComputedStyle(cell).display !== "none").flatMap(cell => {
          const b = cell.getBoundingClientRect();
          return b.width && (b.left < box.left - 1 || b.right > box.right + 1 || b.top < box.top - 1 || b.bottom > box.bottom + 1)
            ? [{ row: row.getAttribute("data-id"), cell: cell.textContent }] : [];
        });
      }))).toEqual([]);
      await admin.screenshot({ path: info.outputPath(`inbox-${width}-${theme}.png`), fullPage: true });
    }
  };
  await walk(1440);
  await atPhoneWidth(admin, async () => {
    await fits(admin, "업무함 기한 그룹");
    await walk(390);
    const more = queue.getByRole("button", { name: "오늘 퇴직 작업", exact: true });
    await more.click();
    await expect(admin.getByRole("dialog", { name: "오늘 퇴직", exact: true }).getByRole("link", { name: "인사 확인하고 퇴직 처리", exact: true })).toBeVisible();
    await admin.keyboard.press("Escape");
    await expect(more).toBeFocused();
  });
  const refusedRow = rows.filter({ hasText: "부여 확인 대상" });
  await refusedRow.getByRole("button", { name: "부여 확인 대상 부여 확인 기록" }).click();
  await expect(refusedRow).toHaveCount(1);
  await expect(refusedRow.getByRole("alert")).toContainText("권한을 받은 본인만 부여 확인을 기록할 수 있습니다");
  expect(refusedWrites).toBe(1);
  await expect(refusedRow.getByRole("button", { name: "부여 확인 대상 부여 확인 기록" })).toBeEnabled();

  await admin.unroute(/\/api\/v1\/me\/action-inbox(\?|$)/);
  await admin.route(/\/api\/v1\/me\/action-inbox(\?|$)/, route => route.fulfill({
    status: 500, contentType: "application/json", json: { error: { code: "internal", message: "unavailable" } },
  }));
  await admin.reload();
  await expect(queue.getByRole("heading", { name: "불러오지 못했습니다", exact: true })).toBeVisible({ timeout: 30_000 });
  const walkFailure = async (width: number) => {
    await fits(admin, "업무함 불러오기 실패");
    await expectAccessible(admin, `Home load-failed at ${width}px`);
    for (const theme of ["light", "dark"]) {
      await admin.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      await admin.screenshot({ path: info.outputPath(`inbox-load-failed-${width}-${theme}.png`), fullPage: true });
    }
  };
  await walkFailure(1440);
  await atPhoneWidth(admin, () => walkFailure(390));
});
