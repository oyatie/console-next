import { expect, test } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { clickCounter } from "./clicks";
import { koDate, kstDate, option } from "./flows";
import { tenantWithExecutive } from "./setup-flows";

// The last finished month and the current one in Korea, as YYYY-MM, and how the app names a month.
const ym = (d: Date) => d.toISOString().slice(0, 7);
const today = kstDate();
const lastMonth = ym(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)));
const thisMonth = today.slice(0, 7);
const monthName = (m: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "UTC", year: "numeric", month: "long" }).format(new Date(`${m}-15T00:00:00Z`));

// Period locks: nothing preselected, a month lock derived from the month, an overlapping window blocked
// with its fixes before the server is asked, and a time-boxed unlock with a reason and a passkey that leaves a receipt.
test("period locks: month lock, overlap blocked with fixes, unlock with a reason", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await tenantWithExecutive(browser, "lockco", "마감주식회사");
  const c = clickCounter();
  const nav = admin.getByRole("navigation", { name: "주 메뉴" });
  await c.click(nav.getByRole("link", { name: "설정", exact: true }));
  await c.click(admin.getByRole("main").getByRole("link", { name: "기간 잠금", exact: true }));
  await expect(admin.getByText("잠긴 기간이 없습니다")).toBeVisible();
  // Settings views keep 설정 current.
  await expect(nav.getByRole("link", { name: "설정", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "기간 잠금" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "직원", exact: true })).not.toHaveAttribute("aria-current", "page");
  await expectAccessible(admin, "period locks (empty)");

  // Nothing is chosen: pressing the primary lists the errors and moves to the first.
  const payroll = admin.getByRole("radio", { name: "급여", exact: true });
  await expect(payroll).not.toBeChecked();
  await expect(admin.getByRole("radio", { name: "회계", exact: true })).not.toBeChecked();
  await expect(admin.getByRole("combobox", { name: /^월/ })).toHaveValue("");
  await admin.getByRole("button", { name: "기간 잠금", exact: true }).click();
  await expect(admin.getByText("업무 영역을 선택하십시오")).toBeVisible();
  await expect(payroll).toBeFocused();
  await expectAccessible(admin, "period locks (errors)");
  c.done("errors");

  // A month lock: the window is derived from the month.
  await c.click(option(admin, "업무 영역", "급여"));
  await c.select(admin.getByRole("combobox", { name: /^월/ }), lastMonth);
  await expect(admin.getByRole("group", { name: "기간" })).toContainText(`${lastMonth.slice(0, 4)}. ${lastMonth.slice(5, 7)}. 01.`);
  await c.click(option(admin, "잠금 사유", "월 급여 마감"));
  await c.click(admin.getByRole("button", { name: `급여 ${monthName(lastMonth)} 잠금` }));
  await expect(admin.getByRole("status").filter({ hasText: `급여 ${monthName(lastMonth)} 기간을 잠갔습니다` })).toBeVisible();
  const row = admin.getByRole("row", { name: /월 급여 마감/ });
  await expect(row).toBeVisible();
  expect(c.done("lock a payroll month")).toBeLessThanOrEqual(5);

  // An overlapping window is blocked before the server is asked, with the lock it overlaps and two fixes.
  await option(admin, "업무 영역", "급여").click();
  await option(admin, "기간 방식", "기간 직접 지정").click();
  await admin.getByLabel(/^시작일/).fill(`${lastMonth}-15`);
  await admin.getByLabel(/^종료일/).fill(`${thisMonth}-15`);
  await admin.getByLabel(/^종료일/).blur();
  await expect(admin.getByText(/겹칩니다/)).toBeVisible();
  await expect(admin.getByRole("button", { name: /^급여 [^·]* 잠금$/ })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "period locks (overlap blocked)");
  await admin.getByRole("button", { name: "기존 잠금 보기" }).click();
  await expect(row.getByRole("button", { name: /잠금 해제/ })).toBeFocused();
  await admin.getByRole("button", { name: /부터로 변경$/ }).click();
  await expect(admin.getByLabel(/^시작일/)).toHaveValue(koDate(`${thisMonth}-01`));
  await expect(admin.getByText(/겹칩니다/)).toBeHidden();

  // Esc with input only arms; a second Esc closes the card, and reopening it keeps the input.
  const start = admin.getByLabel(/^시작일/);
  await start.press("Escape");
  await expect(admin.getByText(/Esc를 한 번 더 누르면/)).toBeVisible();
  await start.press("Escape");
  await expect(start).toBeHidden();
  const open = admin.getByRole("button", { name: "새 기간 잠금" });
  await expect(open).toBeFocused();
  await open.click();
  await expect(start).toHaveValue(koDate(`${thisMonth}-01`));

  await atPhoneWidth(admin, () => fits(admin, "period locks"));

  // Unlock (BW-15): a reason code, the last day it stays open (it locks again on its own), then the passkey bound to
  // this unlock. The sole close authority unlocks at once, flagged for review; focus lands on the locked list.
  await c.click(row.getByRole("button", { name: `급여 ${monthName(lastMonth)} 잠금 해제` }));
  const dialog = admin.getByRole("dialog", { name: `급여 ${monthName(lastMonth)} 잠금 해제` });
  const commit = dialog.getByRole("button", { name: "패스키로 확인하고 잠금 해제" });
  await commit.click(); // a check, not part of the journey: nothing chosen yet
  await expect(dialog).toContainText("사유 분류를 선택하십시오");
  await expect(dialog).toContainText("열어 둘 마지막 날을 선택하십시오");
  await c.click(option(admin, "해제 사유", "소급 정정"));
  await dialog.getByLabel("해제 메모").fill("급여 정정 반영");
  await c.click(dialog.getByRole("button", { name: /^1일 동안/ }));
  await expect(dialog).toContainText("0시에 다시 잠깁니다");
  await expectAccessible(admin, "unlock dialog");
  await c.click(commit);
  await expect(admin.getByRole("status").filter({ hasText: "잠금을 해제했습니다" })).toContainText("사후 검토 대상");
  await expect(admin.getByRole("heading", { name: "잠긴 기간 0건" })).toBeFocused();
  expect(c.done("unlock with a reason and a time box")).toBeLessThanOrEqual(4);

  await admin.getByRole("button", { name: "해제됨 1" }).click();
  const history = admin.getByRole("row", { name: /월 급여 마감/ });
  await expect(history).toContainText("소급 정정 · 급여 정정 반영");
  await expect(history).toContainText("다시 잠김");
  await expect(history).toContainText("사후 검토 필요");
  await expectAccessible(admin, "period locks (unlocked)");

  // Decision #8b: an unlocked period is locked again early in one click, as a new lock over the same window.
  await history.getByRole("button", { name: `급여 ${monthName(lastMonth)} 지금 다시 잠금` }).click();
  await expect(admin.getByRole("status").filter({ hasText: `급여 ${monthName(lastMonth)} 기간을 잠갔습니다` })).toBeVisible();
  await expect(admin.getByRole("heading", { name: "잠긴 기간 1건" })).toBeVisible();
});
