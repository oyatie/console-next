import { expect, type Page } from "@playwright/test";
import { apiOf } from "./api";
import { draftWeekly, openSchedule } from "./attendance";
import { chooseRadio, kstDate } from "../flows";
import { sheet } from "../sheet";

/**
 * A weekly 09–18 pattern assigned to the first workplace from 40 days ago, through the UI (S1 screens), so the
 * month timesheet has past work days to record.
 */
export async function officeSchedule(admin: Page) {
  await openSchedule(admin);
  await admin.getByRole("tab", { name: /근무 유형/ }).click();
  const p = await draftWeekly(admin, "사무 09–18", ["09:00", "18:00", "12:00", "13:00"]);
  await p.getByRole("button", { name: "사무 09–18 추가" }).click();
  await admin.getByRole("tab", { name: "달력" }).click();
  await admin.getByRole("button", { name: "이 범위에 근무 일정 지정" }).click();
  const s = sheet(admin, "근무 일정 지정");
  await s.getByRole("combobox", { name: /^근무 유형/ }).selectOption({ label: "사무 09–18" });
  await s.getByRole("textbox", { name: /^적용 시작일/ }).fill(kstDate(-40));
  await chooseRadio(s, /기본 일정/);
  await s.getByRole("button", { name: /에게 .+부터 적용$/ }).click();
  await expect(admin.getByRole("status").filter({ hasText: /적용했습니다/ })).toBeVisible();
}

/** A past work day of this month or the last (read from the server's own plan), and its month. */
export async function pastWorkDay(api: ReturnType<typeof apiOf>, employeeId: string) {
  for (const back of [0, 1]) {
    const month = kstDate(-back * 28).slice(0, 7);
    const pm = (await (await api(`/attendance/people/${employeeId}/month?month=${month}`)).json()) as { days: { date: string; plan: { kind: string } }[] };
    const days = pm.days.filter((d) => d.plan.kind === "WORK" && d.date < kstDate(0));
    if (days.length >= 2) return { month, date: days.at(-1)!.date, other: days.at(-2)!.date };
  }
  throw new Error("no past work day");
}

/** The month timesheet of `month`, with focus in the grid. */
export async function openMonth(admin: Page, month: string) {
  await admin.getByRole("navigation", { name: "근태 화면" }).getByRole("link", { name: "월간 근무표" }).click();
  const grid = admin.getByRole("grid", { name: "월간 근무표" });
  while (!(await admin.getByText(new RegExp(`${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`)).first().isVisible())) {
    await admin.getByRole("button", { name: "이전 달" }).click();
  }
  await expect(grid).toBeVisible();
  return grid;
}

/** The grid cell of a person on a date (its accessible name starts with both). */
export const cellOf = (admin: Page, name: string, date: string) => admin.getByRole("gridcell", { name: new RegExp(`^${name} ${date}`) });

/** Paste tab-separated text into whatever has focus (the grid listens for the paste event). */
export async function pasteText(admin: Page, text: string) {
  await admin.evaluate((t) => {
    // Firefox keeps a synthetic event's DataTransfer empty, so the clipboard is the event's own getData (both browsers).
    const e = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? t : "") } });
    document.activeElement?.dispatchEvent(e);
  }, text);
}
