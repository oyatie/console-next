import { expect, type Locator, type Page } from "@playwright/test";
import { chooseRadio, go } from "../flows";
import { sheet } from "../sheet";

export type AttendanceEntry = "direct" | "menu";

/** Setup fixtures retain direct entry; the operating first-run journey must use the main menu. */
export async function openAttendance(admin: Page, entry: AttendanceEntry = "direct") {
  if (entry === "menu") await admin.getByRole("navigation", { name: "주 메뉴", exact: true }).getByRole("link", { name: "근태", exact: true }).click();
  else await go(admin, "/attendance");
  await expect(admin.getByRole("heading", { level: 1, name: "근태" })).toBeVisible();
}

/** 근태 › 근무 일정 (the month timesheet is the default tab, so the schedule is one tab away). */
export async function openSchedule(admin: Page, entry: AttendanceEntry = "direct") {
  await openAttendance(admin, entry);
  await admin.getByRole("navigation", { name: "근태 화면" }).getByRole("link", { name: "근무 일정" }).click();
}

/** One working weekday of the pattern sheet: its four clocks. */
async function fillDay(s: Locator, day: string, start: string, end: string, breakStart: string, breakEnd: string) {
  const g = s.getByRole("group", { name: day, exact: true });
  await g.getByRole("textbox", { name: /^시업/ }).fill(start);
  await g.getByRole("textbox", { name: /^종업/ }).fill(end);
  await g.getByRole("textbox", { name: /^휴게 시작/ }).fill(breakStart);
  await g.getByRole("textbox", { name: /^휴게 끝/ }).fill(breakEnd);
}

/**
 * Adds a weekly pattern Monday–Friday with the given clocks (Saturday 휴무, Sunday 주휴 as the sheet lays them out),
 * leaving the sheet open on the commit so the caller asserts or commits.
 */
export async function draftWeekly(admin: Page, name: string, clocks: [string, string, string, string]) {
  await admin.getByRole("button", { name: "근무 유형 추가" }).first().click();
  const s = sheet(admin, "근무 유형 추가");
  await fillWeeklyPattern(s, name, clocks);
  return s;
}

/** Fill the shared pattern form whether opened from patterns or a missing-schedule remedy. */
export async function fillWeeklyPattern(s: Locator, name: string, clocks: [string, string, string, string]) {
  await s.getByRole("textbox", { name: /^이름/ }).fill(name);
  await chooseRadio(s, /^통상/);
  await chooseRadio(s, /공휴일에 쉼/);
  for (const day of ["월", "화", "수", "목", "금"]) await fillDay(s, day, ...clocks);
}
