// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { minimumColumnWidth } from "./column-types";

test("row budget respects fixed widths and flexible column minimums without parsing relative sizes", () => {
  expect(minimumColumnWidth([
    { width: "3fr", minWidth: 232 },
    { width: 88 },
    { width: "20%" },
    { width: 64, minWidth: 96 },
    { width: 196, minWidth: 100, card: "action" },
    {},
  ])).toBe(612);
  expect(minimumColumnWidth([])).toBe(0);
  expect(minimumColumnWidth([{ width: 1600 }])).toBe(0);
  expect(minimumColumnWidth([{ width: 160, type: "action" }])).toBe(160);
});
