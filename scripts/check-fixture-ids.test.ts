// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, it } from "vitest";
import { rrnChecksumValid, strippedZeroRrn, validRrnLines } from "./check-fixture-ids.mjs";

// Built at run time so this file never carries a checksum-valid number itself.
const withCheckDigit = (twelve: string) =>
  [...Array(10).keys()].map((d) => twelve + d).find((v) => rrnChecksumValid(v)) as string;

describe("check-fixture-ids", () => {
  const valid = withCheckDigit("900101123456");
  const invalid = valid.slice(0, 12) + ((Number(valid[12]) + 1) % 10);

  it("knows the check digit", () => {
    expect(rrnChecksumValid(valid)).toBe(true);
    expect(rrnChecksumValid(invalid)).toBe(false);
  });

  it("flags a valid RRN with or without the dash, and only that line", () => {
    const dashed = `${valid.slice(0, 6)}-${valid.slice(6)}`;
    expect(validRrnLines(`a\nrrn: "${dashed}"\nb ${valid}\nc ${invalid}`)).toEqual([2, 3]);
  });

  it("ignores digits inside longer numbers and impossible dates", () => {
    expect(validRrnLines(`1${valid}`)).toEqual([]);
    expect(validRrnLines(withCheckDigit("901301123456"))).toEqual([]);
  });

  // Excel strips a 2000s birth year's leading zeros: 0101013xxxxxx is stored as 101013xxxxxx (12 digits) and
  // 0011013xxxxxx as 11013xxxxxx (11), and the backend's importer reads both as RRNs (pii.rs is_stripped_zero_rrn).
  const stripped12 = withCheckDigit("010101345678").slice(1);
  const stripped11 = withCheckDigit("001101341234").slice(2);

  it("flags a checksum-valid RRN in its stripped-zero form, with or without Excel's .0", () => {
    expect(strippedZeroRrn(stripped12)).toBe(`0${stripped12}`);
    expect(validRrnLines(`a\n"${stripped12}"\n${stripped12}.0\n"${stripped11}"`)).toEqual([2, 3, 4]);
  });

  it("leaves stripped forms the importer would not read as an RRN", () => {
    const bump = (v: string) => v.slice(0, -1) + ((Number(v.at(-1)) + 1) % 10);
    expect(validRrnLines(bump(stripped12))).toEqual([]); // checksum fails
    expect(validRrnLines(`0${stripped11}`)).toEqual([]); // a leading zero: a phone-shaped 12 digits, not stripped
    expect(validRrnLines(withCheckDigit("010101145678").slice(1))).toEqual([]); // gender digit 1 is a 1900s birth
    expect(validRrnLines(withCheckDigit("050229345678").slice(1))).toEqual([]); // 2005 is not a leap year
    expect(validRrnLines(`1.${stripped12}`)).toEqual([]); // the fraction of a decimal
  });
});
