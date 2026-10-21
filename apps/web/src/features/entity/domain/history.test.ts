import { describe, expect, test } from "vitest";
import { recordedDay, revisionKind } from "./history";

describe("entity history entries", () => {
  // Regression (parity S3): the record rail dated an entry by the UTC date of its instant, so everything recorded
  // before 09:00 KST read as the day before.
  test("regression: the record day is Korea's day of the instant, never the UTC date", () => {
    expect(recordedDay("2026-10-06T20:00:00Z")).toBe("2026-10-07");
    expect(recordedDay("2026-10-06T14:59:59Z")).toBe("2026-10-06");
    expect(recordedDay("2026-10-06T15:00:00Z")).toBe("2026-10-07");
    expect(recordedDay("2026-12-31T15:00:00+00:00")).toBe("2027-01-01");
    expect(recordedDay("2028-02-28T15:30:00Z")).toBe("2028-02-29");
  });
  // Regression (walkthrough W20): the VAT unit the certificates set read as the admin's own 「변경」.
  test("regression: the VAT unit set by the certificates is its own kind, not a change", () => {
    expect(revisionKind({ version: 2, reason_code: "VAT_UNIT_DERIVED" })).toBe("derived");
    expect(revisionKind({ version: 3, reason_code: "VAT_UNIT_DECLARED" })).toBe("declared");
    expect(revisionKind({ version: 1, reason_code: "CREATE" })).toBe("created");
    expect(revisionKind({ version: 4, reason_code: "CORRECTION" })).toBe("corrected");
    expect(revisionKind({ version: 5, reason_code: "CHANGE" })).toBe("changed");
  });
});
