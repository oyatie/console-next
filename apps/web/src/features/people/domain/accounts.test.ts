import { expect, test } from "vitest";
import { accountsSearch, holdsActive, holdsLink, sheetOf, unknownOutcome } from "./accounts";

// regression (governance-01): no preset roles — a role in the URL is not state, and no role sheet opens.
test("URL state: roles and unknown acts are dropped, the toggle reads 1 or true", () => {
  expect(accountsSearch({ role: "SUPER_ADMIN", inactive: "1", act: "", employee: "e1" })).toEqual({ inactive: true, act: undefined, employee: "e1" });
  expect(sheetOf("invite")).toEqual({ kind: "invite" });
  expect(sheetOf("role:u1")).toBeUndefined();
  expect(sheetOf("TRANSFER")).toBeUndefined();
});

test("an unkeyed command is looked up only when its outcome is unknown, and the account read again decides", () => {
  expect(unknownOutcome(new TypeError("Failed to fetch"))).toBe(true);
  expect(unknownOutcome({ status: 503, code: "unavailable" })).toBe(true);
  expect(unknownOutcome({ status: 409, code: "invalid_transition" })).toBe(true);
  expect(unknownOutcome({ status: 422, code: "validation" })).toBe(false);
  expect(unknownOutcome(new DOMException("cancelled", "NotAllowedError"))).toBe(false);
  const u = { employee_id: null, is_active: false };
  expect(holdsLink(null)(u)).toBe(true);
  expect(holdsLink("e1")(u)).toBe(false);
  expect(holdsActive(false)(u)).toBe(true);
});
