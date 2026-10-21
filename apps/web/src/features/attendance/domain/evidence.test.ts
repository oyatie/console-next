import { expect, test } from "vitest";
import { EMPTY_EVIDENCE, evidenceOf } from "./evidence";

test("evidence is incomplete until chosen, a supervisor is named, and 'other' is described", () => {
  expect(evidenceOf(EMPTY_EVIDENCE)).toBeNull();
  expect(evidenceOf({ ...EMPTY_EVIDENCE, kind: "SUPERVISOR_CONFIRM" })).toBeNull();
  expect(evidenceOf({ ...EMPTY_EVIDENCE, kind: "SUPERVISOR_CONFIRM", confirmer: { id: "e1", name: "x" } })).toEqual({ kind: "SUPERVISOR_CONFIRM", note: undefined, confirmer_employee_id: "e1" });
  expect(evidenceOf({ ...EMPTY_EVIDENCE, kind: "OTHER", note: " " })).toBeNull();
  expect(evidenceOf({ ...EMPTY_EVIDENCE, kind: "PAPER_SHEET" })).toEqual({ kind: "PAPER_SHEET", note: undefined, confirmer_employee_id: undefined });
});
