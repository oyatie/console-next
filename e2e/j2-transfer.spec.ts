import { expect, test } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { clickCounter } from "./clicks";
import { withLifecycleDate } from "./clock";
import { go, kstDate, koDate, registerEmployee } from "./flows";
import { expectHrActs, expectNoHrActs, hrAct, openHistory } from "./record";
import { staffedTenant } from "./setup-flows";
import { koDay } from "./dates";
import { dateBox, koMonthDay, reasonBox, said, sheet, todayPreset, fillDate } from "./sheet";
import { reasonChip } from "./helpers/lifecycle";

// J2 발령: the employee page offers the events the server accepts now, each in a side sheet with the sign-offs it
// requires. No date has a default: the commit names the date, blue while it schedules, red once it applies now.
// Click budgets = base + the date pick (1) + the reason code (1, BW-07); no statement to tick (BW-11 A13).
test("J2 appointment: transfer and promotion from the server's allowed events; a no-op is refused", { tag: ["@hr", "@clock"] }, async ({ browser }) => {
  const { admin, exec } = await staffedTenant(browser, "j2co", "발령주식회사");
  const c = clickCounter();
  await registerEmployee(admin, { name: "오발령", number: "J2-0001", position: "대리" });
  await openHistory(admin);
  await expectHrActs(admin, ["전보", "전적", "승진 처리", "직책 임면", "고용형태 전환", "휴직 처리"]);

  await hrAct(admin, "전보", c.click);
  const transfer = sheet(admin, "오발령 전보");
  // Nothing is chosen: no date, no unit; the commit is never dead, it says what is missing and goes there.
  await expect(dateBox(transfer)).toHaveValue("");
  await expect(transfer).toContainText("시행일을 선택하면 바로 반영할지 예약할지 정해집니다");
  await transfer.getByRole("button", { name: "전보 예약", exact: true }).click(); // a check, not part of the journey
  await expect(transfer).toContainText("4개 항목을 채워야 합니다");
  await expect(transfer.getByRole("combobox", { name: "어디로" })).toBeFocused();
  await expectAccessible(admin, "J2: transfer sheet with what is missing");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용");
  await c.click(admin.getByRole("option", { name: /채용팀/ }));
  await c.click(todayPreset(transfer));
  await expect(transfer).toContainText("오발령님을 오늘자로 인사부에서 채용팀으로 전보합니다. 바로 반영됩니다. 잘못 기록했다면 인사 이력에서 정정하거나 철회합니다");
  await c.click(reasonChip(transfer, "업무 필요"));
  await reasonBox(transfer).fill("채용 업무 전담");
  await expect(transfer.getByRole("checkbox")).toHaveCount(0); // BW-11 A13: no statement to tick
  await expectAccessible(admin, "J2: transfer sheet");
  // Applies now: red.
  await expect(transfer.getByRole("button", { name: "오늘 전보", exact: true })).toHaveClass(/btn--danger/);
  await c.click(transfer.getByRole("button", { name: "오늘 전보", exact: true }));
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /오발령을 인사부에서 채용팀으로 전보했습니다/ })).toBeVisible();
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("status").filter({ hasText: "오발령님을 채용팀으로 전보했습니다" })).toBeVisible();
  expect(c.done("J2 transfer (base 4 with 발령 → 전보, spec §5 + 1 date + 1 reason code)")).toBeLessThanOrEqual(6);

  // Promoting to the current position changes nothing: the server refuses it and says why.
  await hrAct(admin, "승진 처리", c.click);
  const promote = sheet(admin, "오발령 승진 처리");
  const position = promote.getByRole("textbox", { name: /^새 직위/ });
  await position.fill("대리");
  await c.click(todayPreset(promote));
  await c.click(reasonChip(promote, "정기 승진"));
  await reasonBox(promote).fill("정기 승진");
  await c.click(promote.getByRole("button", { name: "오늘 승진 처리", exact: true }));
  const refused = promote.getByRole("alert");
  await expect(refused).toContainText("바뀌는 것이 없습니다");
  await expect(refused).toContainText("이미 대리입니다");
  await expectAccessible(admin, "J2: refused promotion");
  await c.click(refused.getByRole("button", { name: "다른 직위 입력" }));
  await expect(position).toBeFocused();
  await position.fill("과장");
  await c.click(promote.getByRole("button", { name: "오늘 승진 처리", exact: true }));
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /오발령을 대리에서 과장으로 승진 처리했습니다/ })).toBeVisible();
  expect(c.done("J2 promote (base 3 with 발령 + 1 date + 1 reason code + 2 to fix one refusal)")).toBeLessThanOrEqual(7);

  // A later date schedules the transfer: nothing changes until then, the record shows it as 효력 예정
  // with its next event, and it can be cancelled before the date.
  const head = admin.getByRole("heading", { name: /오발령/, level: 1 }).locator("..");
  const profile = admin.getByRole("group", { name: "소속" });
  const history = admin.getByRole("region", { name: "인사 이력" });
  const next = admin.getByRole("group", { name: "다음 일정" });
  const later = kstDate(5);
  await hrAct(admin, "전보", c.click);
  const unit = transfer.getByRole("combobox", { name: "어디로" });
  // Esc closes the open picker first and leaves the sheet; a second Esc closes the sheet.
  await unit.fill("인");
  await expect(admin.getByRole("listbox")).toBeVisible();
  await admin.keyboard.press("Escape");
  await expect(admin.getByRole("listbox")).toHaveCount(0);
  await expect(transfer).toBeVisible();
  await unit.fill("인사");
  await c.click(admin.getByRole("option", { name: /인사부/ }));
  await fillDate(transfer, later);
  // Withdrawable until its date: blue, and the sentence says what holds until then, never "cannot be undone".
  await expect(transfer).toContainText(said("오발령님을 {day}자로 채용팀에서 인사부로 전보하도록 예약합니다", later));
  await expect(transfer).toContainText("그날까지는 채용팀 소속이며, 그 전에 예약을 취소할 수 있습니다");
  await expect(transfer).not.toContainText("되돌릴 수 없습니다");
  await c.click(reasonChip(transfer, "정기 인사"));
  await reasonBox(transfer).fill("인사부 복귀");
  await expectAccessible(admin, "J2: scheduled transfer sheet");
  const schedule = transfer.getByRole("button", { name: `전보 예약 · ${later.slice(5)} 시행`, exact: true });
  await expect(schedule).toHaveClass(/btn--primary/);
  await c.click(schedule);
  await expect(history.getByText(/오발령을 인사부로 전보하도록 예약했습니다/)).toBeVisible();
  await expect(history.getByRole("listitem").filter({ hasText: "전보하도록 예약했습니다" })).toContainText(`${koDate(later)} 시행 예정`);
  await expect(head.getByText("효력 예정")).toBeVisible();
  await expect(next).toContainText(`${koDate(later)} 전보 예정`);
  await expect(profile).toContainText("채용팀"); // still in the current unit until the date
  await expectAccessible(admin, "J2: employee with a scheduled transfer");
  expect(c.done("J2 schedule a transfer")).toBeLessThanOrEqual(6);

  // Another transfer on the same date replaces the reservation: the sheet says so before it is saved.
  await hrAct(admin, "전보");
  await fillDate(transfer, later);
  await expect(transfer).toContainText(`${koMonthDay(later)} 전보 예약을 이 내용으로 변경합니다`);
  await transfer.getByRole("button", { name: "취소", exact: true }).click();
  await expect(transfer).toBeHidden();

  await atPhoneWidth(admin, async () => {
    await expect(head.getByText("효력 예정")).toBeVisible();
    await fits(admin, "J2: employee with a scheduled transfer (chips, cancel in the history)");
    await go(admin, "/people");
    await fits(admin, "J2: people list with the scheduled transfer as the next item");
    // The table scrolls sideways inside its card; the columns past the edge render as they come into view.
    const grid = admin.getByRole("grid", { name: "직원" });
    await expect(grid.getByRole("rowheader", { name: "오발령", exact: true })).toBeVisible();
    await grid.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await expect(admin.getByRole("row", { name: /오발령/ })).toContainText(`전보 · ${koDate(later)}`);
  });
  const row = admin.getByRole("row", { name: /오발령/ });
  await expect(row).toContainText(`전보 · ${koDate(later)} · D-`);
  await expectAccessible(admin, "J2: people list with a scheduled change");

  // An executive reads the record but changes nothing: no HR actions, no cancel, pay not shown.
  await go(exec, "/people");
  await c.click(exec.getByRole("rowheader", { name: "오발령", exact: true }));
  await c.click(exec.getByRole("complementary", { name: "직원 상세" }).getByRole("link", { name: "인사카드 열기" }));
  await expect(exec.getByRole("heading", { name: /오발령/, level: 1 })).toBeVisible();
  const execProfile = exec.getByRole("region", { name: "재직·배치" });
  await expect(execProfile).toContainText("열람 권한 없음");
  await expect(exec.getByRole("group", { name: "다음 일정" })).toContainText(`${koDate(later)} 전보 예정`);
  await expect(exec.getByRole("region", { name: "다음 기록" })).toContainText(`전보 · ${koDay(later)}`);
  // BW-17: a reader who cannot change the record asks HR instead.
  await expect(exec.getByText("이 기록은 인사팀이 수정합니다")).toBeVisible();
  await expect(exec.getByRole("button", { name: "인사팀에 변경 요청" })).toBeVisible();
  await openHistory(exec);
  await expect(exec.getByRole("region", { name: "인사 이력" })).toContainText("전보하도록 예약했습니다");
  await expectNoHrActs(exec);
  await expect(exec.getByRole("button", { name: /예약 (취소|변경)/ })).toHaveCount(0);
  await expectAccessible(exec, "J2: read-only employee page (executive)");
  expect(c.done("J2 executive opens the record")).toBeLessThanOrEqual(2);

  await admin.goBack();
  await c.click(history.getByRole("button", { name: "전보 예약 취소" }));
  const cancel = sheet(admin, "전보 예약 취소");
  await expect(cancel).toContainText(said("{day} 전보 예약", later));
  await expect(cancel).toContainText("이 예약을 취소합니다. 오발령님의 기록은 바뀌지 않으며");
  await cancel.getByRole("textbox", { name: /^취소 사유/ }).fill("발령 계획 변경");
  await expectAccessible(admin, "J2: cancel a scheduled transfer");
  const withdraw = cancel.getByRole("button", { name: "전보 예약 취소" });
  await expect(withdraw).toHaveClass(/btn--danger/);
  await c.click(withdraw);
  // The receipt heads the history; the withdrawn record is kept, shown on request, struck through.
  await expect(history.getByRole("status").filter({ hasText: "오발령님의 전보 예약을 취소했습니다" })).toBeVisible();
  // The withdrawn record is hidden by default, so focus goes to the history heading.
  await expect(admin.getByRole("heading", { name: "인사 이력" })).toBeFocused();
  await history.getByRole("button", { name: "취소된 기록 포함 (1건)" }).click();
  const cancelled = history.getByRole("listitem").filter({ hasText: "전보하도록 예약했습니다" });
  await expect(cancelled).toContainText("취소됨");
  await expect(cancelled).toContainText("취소 사유: 발령 계획 변경");
  await expect(head.getByText("효력 예정")).toHaveCount(0);
  await expect(next).toContainText("예정된 발령 없음");
  expect(c.done("J2 cancel the scheduled transfer")).toBeLessThanOrEqual(2);

  // Another scheduled transfer stays SCHEDULED until its date; on that date the server applies it (a background
  // run, here on a date the test moves the backend's apply clock to): the person moves and the 효력 예정 marks go.
  const moveOn = kstDate(7);
  await hrAct(admin, "전보", c.click);
  await transfer.getByRole("combobox", { name: "어디로" }).fill("인사");
  await c.click(admin.getByRole("option", { name: /인사부/ }));
  await fillDate(transfer, moveOn);
  await c.click(reasonChip(transfer, "정기 인사"));
  await reasonBox(transfer).fill("하반기 인사부 복귀");
  await c.click(transfer.getByRole("button", { name: `전보 예약 · ${moveOn.slice(5)} 시행`, exact: true }));
  const scheduled = history.getByRole("listitem").filter({ hasText: "하반기 인사부 복귀" });
  await expect(scheduled).toContainText("인사부로 전보하도록 예약했습니다");
  await expect(scheduled).toContainText("효력 예정");
  await expect(scheduled.getByRole("button", { name: "전보 예약 취소" })).toBeVisible();
  await expect(next).toContainText(`${koDate(moveOn)} 전보 예정`);
  expect(c.done("J2 schedule another transfer")).toBeLessThanOrEqual(5);

  await withLifecycleDate(moveOn, async () => {
    // Pages keep what they read for 30 s: reload (a few times at most; the session refresh is rate-limited).
    await expect(async () => {
      // Reload only a loaded page: a reload during its session refresh replays the rotated token, which signs out.
      await expect(scheduled).toBeVisible();
      await admin.reload();
      await expect(scheduled).toContainText("인사부로 전보되었습니다", { timeout: 1_000 });
      // The record and its history are separate reads; the apply can land between them.
      await expect(head.getByText("효력 예정")).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ intervals: [2_000, 3_000, 5_000], timeout: 30_000 });
  });
  // It took effect on its date, by the scheduler: the history says so, credits who scheduled it, and lists it
  // by when it applied (above the promotion recorded before it).
  await expect(scheduled).toContainText(`오발령이 ${koDate(moveOn)}자로 채용팀에서 인사부로 전보되었습니다 (예약: `);
  await expect(history.getByRole("listitem").first()).toContainText("하반기 인사부 복귀");
  await expect(scheduled).not.toContainText("효력 예정");
  await expect(scheduled.getByRole("button", { name: "전보 예약 취소" })).toHaveCount(0);
  await expect(head.getByText("효력 예정")).toHaveCount(0);
  await expect(next).not.toContainText(`${koDate(moveOn)} 전보 예정`);
  await expect(profile).toContainText("인사부");
  await expect(profile).not.toContainText("채용팀");
  await go(admin, "/people");
  const applied = admin.getByRole("row", { name: /오발령/ });
  await expect(applied).toContainText("인사부");
  await expect(applied).not.toContainText("채용팀");
  await expect(applied).toContainText("과장");
  await expect(applied).not.toContainText("전보 ·"); // nothing scheduled any more
  await expectAccessible(admin, "J2: people list after the scheduled transfer applied");
});
