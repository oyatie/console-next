// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import { APPROVAL_BOXES, approvalBox } from "./inbox";

describe("approvalBox", () => {
  test.each(APPROVAL_BOXES)("keeps the supported %s queue", (box) => {
    expect(approvalBox(box)).toBe(box);
  });

  test.each([undefined, null, "", "waiting", 1])("defaults unknown input %j to pending", (value) => {
    expect(approvalBox(value)).toBe("pending");
  });
});
