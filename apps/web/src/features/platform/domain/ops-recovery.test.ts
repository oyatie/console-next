// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, it } from "vitest";
import { recoveryAction } from "./ops-recovery";

describe("ops recovery has one primary action or a stated reason", () => {
  it("blocks opening without enrollment or a second operator", () => {
    expect(recoveryAction(null, false, true, false)).toBe("notEnrolled");
    expect(recoveryAction(null, true, false, false)).toBe("noSecondOperator");
    expect(recoveryAction(null, true, true, false)).toBe("open");
  });
  it("keeps requester approval, hold, terminal and non-party controls explicit", () => {
    expect(recoveryAction("WAITING_APPROVAL", true, true, true)).toBe("otherOperator");
    expect(recoveryAction("WAITING_APPROVAL", true, true, false)).toBe("approve");
    expect(recoveryAction("HOLD", true, true, true)).toBe("hold");
    expect(recoveryAction("READY", true, true, true)).toBe("issue");
    expect(recoveryAction("READY", true, true, false)).toBe("notParty");
    expect(recoveryAction("ISSUED", true, true, true)).toBe("issued");
    expect(recoveryAction("CANCELLED", true, true, true)).toBe("cancelled");
  });
});

it("the known hold boundary enables issue without polling", () => {
  const until = "1970-01-01T00:00:01Z";
  expect(recoveryAction("HOLD", true, true, true, true, until, 999)).toBe("hold");
  expect(recoveryAction("HOLD", true, true, true, true, until, 1000)).toBe("issue");
  expect(recoveryAction("HOLD", true, true, false, true, until, 1001)).toBe("notParty");
});

it("inactive tenants keep recovery visible with an explicit issue or open prerequisite", () => {
  expect(recoveryAction(null, true, true, true, false)).toBe("inactive");
  expect(recoveryAction("READY", true, true, true, false)).toBe("inactive");
  expect(recoveryAction("WAITING_APPROVAL", true, true, false, false)).toBe("approve");
});
