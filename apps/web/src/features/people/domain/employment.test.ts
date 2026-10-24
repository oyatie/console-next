// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { employedOn, retirementDate } from "./employment";

test.each([
  ["2026-10-22", "2026-10-23"],
  ["2026-04-30", "2026-05-01"],
  ["2026-12-31", "2027-01-01"],
  ["2028-02-28", "2028-02-29"],
  ["2028-02-29", "2028-03-01"],
  ["2026-02-28", "2026-03-01"],
])("retirement is the day after the last working day %s", (last, retirement) => {
  expect(retirementDate(last)).toBe(retirement);
});

test("employment includes hire and last working day, excluding retirement day", () => {
  expect(employedOn("2026-10-20", "2026-10-21", "2026-10-22")).toBe(false);
  expect(employedOn("2026-10-21", "2026-10-21", "2026-10-22")).toBe(true);
  expect(employedOn("2026-10-22", "2026-10-21", "2026-10-22")).toBe(true);
  expect(employedOn("2026-10-23", "2026-10-21", "2026-10-22")).toBe(false);
  expect(employedOn("2026-11-01", "2026-10-21", "2026-10-22")).toBe(false);
});

test("an ongoing employment starts on hire and has no end", () => {
  expect(employedOn("2026-10-20", "2026-10-21")).toBe(false);
  expect(employedOn("2026-10-21", "2026-10-21")).toBe(true);
  expect(employedOn("2027-01-01", "2026-10-21")).toBe(true);
});

test("a one-day employment counts only its working day across year end", () => {
  expect(employedOn("2026-12-31", "2026-12-31", "2026-12-31")).toBe(true);
  expect(employedOn("2027-01-01", "2026-12-31", "2026-12-31")).toBe(false);
});
