import type { Locator, Page } from "@playwright/test";
import { kstDate } from "./flows";

/**
 * A lifecycle sheet's title is the act ("전보") with the person in the line above it (spec E5); a test may still name
 * it "<person> <act>" as the sheets used to read.
 */
const ACTS: Record<string, string> = { "전보": "전보", "승진 처리": "승진 · 강등", "휴직 처리": "휴직", "복직 처리": "복직", "계약 갱신": "계약 갱신 · 변경" };
/** The open side sheet (one at a time), by its title. */
export function sheet(page: Page, name?: string | RegExp) {
  if (typeof name === "string")
    for (const [old, act] of Object.entries(ACTS))
      if (name.endsWith(` ${old}`)) return page.getByRole("dialog", { name: act, exact: true }).filter({ hasText: name.slice(0, -old.length - 1) });
  return page.getByRole("dialog", name === undefined ? undefined : { name });
}
/** The free-text reason of a lifecycle sheet. */
export const reasonBox = (s: Locator) => s.getByRole("textbox", { name: /^사유/ });
/** A date field of a sheet by its label ("언제부터"/"시행일", "시작일", "복귀 예정일", "새 계약 종료일"). */
export const dateBox = (s: Locator, label = "언제부터|시작일|시행일") => s.getByRole("textbox", { name: new RegExp(`^(${label})`) });
/**
 * Types a date into a sheet's date field. A chips-first date (spec E5) shows its typed field only after 「직접」, which
 * is pressed first when the field is not on screen yet.
 */
export async function fillDate(s: Locator, value: string, label?: string) {
  const box = dateBox(s, label);
  if (!(await box.isVisible())) await s.getByRole("group", { name: new RegExp(`^(${label ?? "언제부터|시작일|시행일"}).* 빠른 선택`) }).getByRole("button", { name: "직접", exact: true }).click();
  await box.fill(value);
}
/** The immediate preset of the date field: 「오늘 10-06」 (chips) or 「오늘 · 바로 반영」 (bulk). */
export const todayPreset = (s: Locator) => s.getByRole("button", { name: /^오늘 (· 바로 반영|\d{2}-\d{2})/ });

const words = (ymd: string, weekday: boolean) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "UTC",
    year: ymd.slice(0, 4) === kstDate().slice(0, 4) ? undefined : "numeric",
    month: "long",
    day: "numeric",
    weekday: weekday ? "short" : undefined,
  }).format(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))));
/** A date as the sheets' buttons and facts write it: "11월 2일" (with the year when it is not this year). */
export const koMonthDay = (ymd: string) => words(ymd, false);
/**
 * A sentence with `{day}` standing for a date as sheets write it in sentences ("11월 2일 (월)"), as a regex: the
 * weekday's punctuation follows the browser's ICU (with a year, some print "목" without brackets).
 */
export const said = (sentence: string, ymd: string) =>
  new RegExp(sentence.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&").replace("\\{day\\}", `${words(ymd, false)} \\(?[월화수목금토일]\\)?`));

/** A sign-off's visible statement, which is what a user presses (the checkbox input itself is visually hidden). */
export const statement = (box: Locator) => box.locator("xpath=ancestor::label[1]");
/** Ticks every sign-off the sheet shows (each is its own click: no "check all"). */
export async function signOff(s: Locator, click: (l: Locator) => Promise<void> = (l) => l.click()) {
  for (const box of await s.getByRole("checkbox").all()) await click(statement(box));
}
