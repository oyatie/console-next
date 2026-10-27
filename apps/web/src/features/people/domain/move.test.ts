// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { moveKind } from "./move";

test.each([
  ["head-office", "head-office", "TRANSFER"],
  ["head-office", "branch-office", "relocate"],
  [null, "branch-office", "TRANSFER"],
  [undefined, "branch-office", "TRANSFER"],
  ["head-office", null, "TRANSFER"],
  ["head-office", undefined, "TRANSFER"],
  [null, null, "TRANSFER"],
] as const)("moveKind(%s, %s) = %s", (from, to, kind) => {
  expect(moveKind(from, to)).toBe(kind);
});
