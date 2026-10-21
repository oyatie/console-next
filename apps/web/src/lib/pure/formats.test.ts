import { expect, test } from "vitest";
import { bizRegNoChecksumOk, complete, corpRegNoChecksumOk, digitsOf, FORMATS, parseWith, phoneDisplay, phoneE164 } from "./formats";

test("digits: full-width and separators are normalised", () => {
  expect(digitsOf("１２３-45 67890")).toBe("1234567890");
  expect(parseWith(FORMATS.bizRegNo, "123-45-678901234")).toBe("1234567890");
});

test("사업자등록번호: mask and the common check digit (a warning only)", () => {
  expect(FORMATS.bizRegNo.display("1234567890")).toBe("123-45-67890");
  expect(FORMATS.bizRegNo.display("1234")).toBe("123-4");
  expect(bizRegNoChecksumOk("0000000000")).toBe(true);
  expect(bizRegNoChecksumOk("0008162516")).toBe(false);
  expect(FORMATS.bizRegNo.warnings("0008162516")).toEqual(["checksum"]);
});

test("법인등록번호: the check digit is tested only for 법인 incorporated before 2025-01-31", () => {
  const sum = (d: string) => [...d].reduce((s, c, i) => s + Number(c) * (i % 2 ? 2 : 1), 0);
  const body = "110111012345";
  const ok = body + String((10 - (sum(body) % 10)) % 10);
  const bad = body + String((Number(ok[12]) + 1) % 10);
  expect(corpRegNoChecksumOk(ok)).toBe(true);
  expect(corpRegNoChecksumOk(bad)).toBe(false);
  expect(FORMATS.corpRegNo.display(ok)).toBe(`${ok.slice(0, 6)}-${ok.slice(6)}`);
  expect(FORMATS.corpRegNo.warnings(bad, { incorporatedOn: "2010-05-01" })).toEqual(["checksum"]);
  // From 2025-01-31 numbers carry no check digit; an unknown date shows nothing either.
  expect(FORMATS.corpRegNo.warnings(bad, { incorporatedOn: "2025-02-03" })).toEqual([]);
  expect(FORMATS.corpRegNo.warnings(bad)).toEqual([]);
});

test.each([
  ["010-1234-0001", "010-1234-0001", "+821012340001"],
  ["0212345678", "02-1234-5678", "+82212345678"],
  ["021234567", "02-123-4567", "+8221234567"],
  ["0311234567", "031-123-4567", "+82311234567"],
  ["15881234", "1588-1234", "+8215881234"],
  ["+82 10-1234-0001", "010-1234-0001", "+821012340001"],
  ["8210-1234-0001", "010-1234-0001", "+821012340001"],
])("phone %s shows as %s and is %s", (raw, shown, e164) => {
  expect(phoneDisplay(parseWith(FORMATS.phone, raw))).toBe(shown);
  expect(phoneE164(raw)).toBe(e164);
});

test("phone: an incomplete number has no E.164 form", () => {
  expect(phoneE164("010-234")).toBeNull();
  expect(complete(FORMATS.phone, "010234")).toBe(false);
});

test("insurance numbers are grouped by four, with a length band", () => {
  expect(FORMATS.insuranceNo.display("12345678901")).toBe("1234 5678 901");
  expect(complete(FORMATS.insuranceNo, "1234567")).toBe(false);
  expect(complete(FORMATS.insuranceNo, "12345678")).toBe(true);
});
