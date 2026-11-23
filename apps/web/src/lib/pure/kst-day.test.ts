// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { kstDayIso, shortMonthDay } from "./kst-day";

test("kstDayIso normalizes KST boundaries and rejects invalid calendar dates", () => {
  expect(kstDayIso("2026-11-10T14:59:59Z")).toBe("2026-11-10");
  expect(kstDayIso("2026-11-10T15:00:00Z")).toBe("2026-11-11");
  expect(kstDayIso("2024-02-28T15:00:00Z")).toBe("2024-02-29");
  expect(kstDayIso("2026-02-28T15:00:00Z")).toBe("2026-03-01");
  expect(kstDayIso("2026-02-30")).toBeNull();
  expect(kstDayIso("2026-99-99")).toBeNull();
  expect(kstDayIso("2026-02-30T09:00:00Z")).toBeNull();
  expect(kstDayIso("not-a-date")).toBeNull();
  expect(kstDayIso(null)).toBeNull();
  expect(shortMonthDay("2026-12-31T23:59:59Z")).toBe("01-01");
  expect(shortMonthDay("2026-02-30")).toBeNull();
});
