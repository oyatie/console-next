import { expect, test } from "vitest";
import { ApiError } from "@console/api";
import { contractOverlap } from "./api/contract-refusal";

const overlap = (row: object) => new ApiError(409, "contract_overlap", "localized message", [], undefined, true, [row as never]);
test("a localized overlap still identifies the contract and its period", () => {
  expect(contractOverlap(overlap({ contract_id: "c", kind: "FIXED_TERM", start_date: "2026-01-01", end_date: "2026-12-31" }))).toEqual({ id: "c", kind: "FIXED_TERM", start: "2026-01-01", end: "2026-12-31" });
});
test.each([{}, { contract_id: "c" }, { contract_id: "c", start_date: "2026-01-01", kind: "unknown" }])("incomplete conflict metadata never offers a correction (%j)", (row) => {
  expect(contractOverlap(overlap(row))).toBeNull();
});
