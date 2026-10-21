import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { cellOf, officeSchedule, openMonth, pastWorkDay, pasteText } from "./helpers/attendance-records";
import { chooseRadio, go, kstDate, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";

// 근태 S2 (A3-grid, A3-save, A3-receipt, A3-correct, A3-void, A12-conflict) from an empty database: a schedule made
// through the UI, then a month of records typed, refused, fixed, pasted, saved with 근거, undone, corrected, voided and
// recorded again, and a cell another HR worker saved first. Every refusal is shown and proven to change nothing.
test("월간 근무표: type, refuse, fix, paste, save with 근거, undo, correct, void, record again, conflict", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(600_000); // a staffed tenant, two people and a schedule through the UI, then eleven steps on the grid (6 min seen under load)
  const { admin } = await staffedTenant(browser, "attrec", "근태기록주식회사");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "R-0001", hired: kstDate(-60) });
  await registerEmployee(admin, { name: "황정우", number: "R-0002", hired: kstDate(-60) });
  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const people = (await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] };
  const yoon = people.items.find((p) => p.name === "윤하준")!.id;
  const { month, date, other } = await pastWorkDay(api, yoon);
  const grid = await openMonth(admin, month);
  await expectAccessible(admin, "month timesheet");

  // A full tab store reports the loss of reload protection while the in-memory draft remains editable.
  const storageSetItem = await admin.evaluateHandle(() => Storage.prototype.setItem);
  await admin.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("console.attendance.drafts:")) throw new DOMException("Full", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  // Typing a later clock-out never makes overtime: `+2` is refused with the pointer to an approval record, and the
  // save stays disabled with its reason; nothing reaches the server.
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.type("+2");
  await admin.keyboard.press("Enter");
  await cellOf(admin, "윤하준", date).click();
  await expect(admin.getByText(/연장은 승인 기록으로만 반영됩니다/).first()).toBeVisible();
  await expect(admin.getByRole("status").filter({ hasText: "초안을 이 탭에 보관하지 못했습니다" })).toBeVisible();
  await admin.evaluate((original) => { Storage.prototype.setItem = original; }, storageSetItem);
  await storageSetItem.dispose();
  await admin.keyboard.press("Delete");
  await expect(admin.getByText(/초안을 이 탭에 보관하지 못했습니다/)).toHaveCount(0);

  // A 12-hour clock-out is read as the morning: refused, with the likely value offered as one fix.
  await admin.keyboard.type("7:48-5:10");
  await admin.keyboard.press("Enter");
  await cellOf(admin, "윤하준", date).click();
  await expect(admin.getByText(/다음 날 퇴근이면 22-6\+ 처럼/).first()).toBeVisible();
  await admin.getByRole("button", { name: "7:48-17:10 입력" }).click();
  let month0 = (await (await api(`/attendance/people/${yoon}/month?month=${month}`)).json()) as { history: unknown[] };
  expect(month0.history).toHaveLength(0);

  // Save with 근거: the primary waits for it (G7), then one transaction and a receipt with the way back.
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await expect(save.getByRole("button", { name: "1칸 저장" })).toHaveAttribute("aria-disabled", "true");
  await chooseRadio(save, /출근부 \(종이\)/);
  await expectAccessible(admin, "save sheet");
  await save.getByRole("button", { name: "1칸 저장" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();

  // 일괄 취소 asks for a reason, then the save stops counting and stays in the history.
  await admin.getByRole("button", { name: "일괄 취소" }).first().click();
  await admin.getByRole("textbox", { name: /^사유/ }).fill("다른 사람 줄에 입력함");
  await admin.getByRole("button", { name: "1칸 일괄 취소" }).click();
  await expect(admin.getByText("1칸을 일괄 취소했습니다 · 이력에 남았습니다")).toBeVisible();

  // Paste two rows by employee number (never by name): both land as drafts in the anchored column.
  await cellOf(admin, "윤하준", other).click();
  await pasteText(admin, "R-0001\t9-18\nR-0002\t=\nX-9999\t9-18");
  await expect(admin.getByText(/붙여넣은 3행을 사번으로 맞췄습니다 · 일치 2 · 없음 1/)).toBeVisible();
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save2 = admin.getByRole("complementary", { name: /저장 · 초안 2칸/ });
  await chooseRadio(save2, /관리자 확인 · 확인자 지정/);
  await save2.getByRole("combobox", { name: /^확인자/ }).fill("황정우");
  await admin.getByRole("option", { name: /황정우/ }).click(); // the list opens in a popover outside the dock
  await save2.getByRole("button", { name: "2칸 저장" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "2칸을 저장했습니다" })).toBeVisible();

  // 정정 with a reason (both values stay in the history), then 기록 취소, then 다시 기록.
  await cellOf(admin, "윤하준", other).click();
  await admin.keyboard.press("p");
  const day = admin.getByRole("complementary", { name: /하루 기록/ });
  await expect(day.getByText("소정·승인 시간 내 인정 · 승인 없는 연장 미인정", { exact: true })).toBeVisible();
  await expect(day).not.toContainText("일정보다 일찍 오거나 늦게 남은 시간은");
  await expectAccessible(admin, "day sheet");
  await day.getByRole("button", { name: "정정" }).click();
  const fix = admin.getByRole("complementary", { name: "기록 정정" });
  await fix.getByRole("textbox", { name: /^정정할 값/ }).fill("9-17");
  await expect(fix.getByText("기록을 낮추는 정정은 근거가 필요합니다")).toBeVisible();
  await fix.getByRole("textbox", { name: /^사유/ }).fill("반장 출근부와 대조");
  await chooseRadio(fix, /출근부 \(종이\)/);
  // The next action must use the corrected entry, even when its refreshed read is slow.
  const monthRead = (url: URL) => url.pathname === `/api/v1/attendance/people/${yoon}/month`;
  let releaseCorrection!: () => void;
  let readStarted!: () => void;
  const correctionRead = new Promise<void>((resolve) => { releaseCorrection = resolve; });
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  await admin.route(monthRead, async (route) => { readStarted(); await correctionRead; await route.continue(); });
  try {
    await fix.getByRole("button", { name: "정정 기록" }).click();
    await started;
    await expect(fix).toBeVisible();
    await expect(fix.getByRole("button", { name: "정정 기록" })).toBeDisabled();
  } finally {
    releaseCorrection();
    await admin.unrouteAll({ behavior: "wait" });
  }
  await expect(admin.getByText(/윤하준 .+ 기록을 정정했습니다/)).toBeVisible();
  await cellOf(admin, "윤하준", other).click();
  await admin.keyboard.press("p");
  await day.getByRole("button", { name: "기록 취소" }).click();
  const voidSheet = admin.getByRole("complementary", { name: "기록 취소" });
  await voidSheet.getByRole("textbox", { name: /^사유/ }).fill("근무하지 않은 날");
  await chooseRadio(voidSheet, /본인 진술/);
  await voidSheet.getByRole("button", { name: "기록 취소" }).click();
  await expect(admin.getByText(/기록을 취소했습니다 · 다시 기록할 수 있습니다/)).toBeVisible();
  month0 = (await (await api(`/attendance/people/${yoon}/month?month=${month}`)).json()) as { history: unknown[] };
  expect(month0.history.length).toBeGreaterThanOrEqual(3);

  // Someone else saves the same cell first: 409 with the three values, no choice made, nothing else saved.
  await cellOf(admin, "황정우", date).click();
  await admin.keyboard.type("9-18");
  await admin.keyboard.press("Enter");
  const hwang = people.items.find((p) => p.name === "황정우")!.id;
  const first = await api("/attendance/entries", "POST", { cells: [{ employee_id: hwang, work_date: date, value: "9-17" }], source: "MANUAL", evidence: { kind: "PAPER_SHEET" } }, { "Idempotency-Key": `attrec-${Date.now()}-first-save` });
  expect(first.status()).toBe(201);
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  await chooseRadio(save, /출근부 \(종이\)/);
  await save.getByRole("button", { name: "1칸 저장" }).click();
  // A12-conflict: the three values side by side, the current one in Korean time, and no choice made for the person.
  await expect(save.getByRole("alert")).toContainText("저장하는 동안 1개 항목이 바뀌었습니다");
  await expect(save.getByRole("radiogroup", { name: /^황정우 .+에 쓸 값/ }).getByRole("radio", { checked: true })).toHaveCount(0);
  const [, mo, dd] = kstDate(0).split("-").map(Number);
  await expect(save.getByText(new RegExp(`${mo}\\. ${dd}\\. \\d{2}:\\d{2}에 바꿈`))).toBeVisible(); // Korean time, not UTC (regression)
  await expect(save.getByRole("button", { name: "1칸 저장" })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "conflict");

  // The server refuses typed overtime on its own too (status and code), and writes nothing.
  const typed = await api("/attendance/entries", "POST", { cells: [{ employee_id: yoon, work_date: date, value: "+2" }], source: "MANUAL", evidence: { kind: "PAPER_SHEET" } }, { "Idempotency-Key": `attrec-${Date.now()}-typed-ot` });
  expect([typed.status(), await codeOf(typed)]).toEqual([422, "cells_refused"]);
});

// A hire adds an earlier change date. Reopening the chart must not paint cached markers and then move them.
test("change-date ribbon waits for its current read after attendance setup", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "attdates", "근태변경일주식회사");
  await go(admin, "/org");
  const ribbon = admin.getByRole("region", { name: "기준일", exact: true }).getByRole("group", { name: "변경일" });
  await expect(ribbon.locator("[data-change-date]").first()).toBeVisible();
  const hired = kstDate(-60);
  await registerEmployee(admin, { name: "윤하준", number: "D-0001", hired });
  const target = (url: URL) => url.pathname === "/api/v1/org-structure/change-dates";
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await admin.route(target, async (route) => { await held; await route.continue(); });
  try {
    await go(admin, "/org");
    await expect(ribbon).toHaveAttribute("aria-busy", "true");
    await expect(ribbon.locator("[data-change-date]")).toHaveCount(0);
    release();
    await expect(ribbon.locator(`[data-change-date="${hired}"]`)).toBeVisible();
    await expect(ribbon).not.toHaveAttribute("aria-busy", "true");
  } finally {
    release();
    await admin.unrouteAll({ behavior: "wait" });
  }
});
