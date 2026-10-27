// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { deadlineBucket } from "./deadline-bucket";

test.each([
  [-10, "danger", "overdue"], [-1, "danger", "overdue"], [0, "danger", "soon"], [1, "warn", "soon"],
  [14, "warn", "soon"], [2, "neutral", "later"], [365, "neutral", "later"],
] as const)("a source deadline with %s days and server tone %s belongs to %s", (days_remaining, dueTone, bucket) => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    expect(deadlineBucket({ due: "2026-10-26T00:00:00Z", days_remaining, dueTone })).toBe(bucket);
  } finally { vi.useRealTimers(); }
});

test("an absent source deadline is undated regardless of other urgency metadata", () => {
  expect(deadlineBucket({ days_remaining: null, dueTone: "warn" })).toBe("undated");
  expect(deadlineBucket({ days_remaining: -1, dueTone: "danger" })).toBe("undated");
});
