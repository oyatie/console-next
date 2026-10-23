import { expect, type Locator, type Page } from "@playwright/test";
import { koDate } from "./flows";
import { koDay } from "./dates";

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
export const dateBox = (s: Locator | Page, label = "언제부터|시작일|시행일") => s.getByRole("textbox", { name: new RegExp(`^(${label})`) });
/** Types and commits the shared date field. */
export async function fillDate(s: Locator | Page, value: string, label?: string) {
  const box = dateBox(s, label);
  await box.fill(value);
  await box.blur();
}
/** The immediate preset of the date field, with its localized date or bulk consequence. */
export const todayPreset = (s: Locator | Page) => s.getByRole("button", { name: /^오늘 (· 바로 반영|\d{4}\.)/ });

/** A business date without the weekday, as sheet buttons and facts show it. */
export const koMonthDay = koDate;
/** A sheet sentence with `{day}` replaced by its business date and weekday. */
export const said = (sentence: string, ymd: string) =>
  new RegExp(sentence.replace("{day}", koDay(ymd)).replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"));

/** A sign-off's visible statement, which is what a user presses (the checkbox input itself is visually hidden). */
export const statement = (box: Locator) => box.locator("xpath=ancestor::label[1]");
/** Ticks every sign-off the sheet shows (each is its own click: no "check all"). */
export async function signOff(s: Locator, click: (l: Locator) => Promise<void> = (l) => l.click()) {
  // A named group has signoffs; a whole sheet may legitimately require none.
  if ("getAttribute" in s && await s.getAttribute("role") === "group") await expect(s.getByRole("checkbox").first()).toBeVisible();
  for (const box of await s.getByRole("checkbox").all()) await click(statement(box));
}
