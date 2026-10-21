// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { koDay } from "../e2e/dates";
import { koMonthDay, said } from "../e2e/sheet";

test.each(["2026-10-26", "2027-10-12"])("E2E dates match the shared business date for %s", (day) => {
  const date = day.replace(/-/g, ". ") + ".";
  expect(koMonthDay(day)).toBe(date);
  expect(koDay(day)).toBe(`${date} (${day === "2026-10-26" ? "월" : "화"})`);
});

test("date sentences escape numeric punctuation and preserve the weekday", () => {
  const sentence = said("전보 · {day} (예약)", "2026-10-26");
  expect("전보 · 2026. 10. 26. (월) (예약)").toMatch(sentence);
  expect("전보 · 2026x 10x 26x (월) (예약)").not.toMatch(sentence);
  expect("전보 · 2026. 10. 26. (화) (예약)").not.toMatch(sentence);
});
