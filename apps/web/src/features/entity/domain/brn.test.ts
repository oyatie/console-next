import { expect, test } from "vitest";
import { brnNeedsLook, brnWarnings, kindsOfBrn } from "./brn";
const classes = [
  { code: "81", biz_kinds: ["CORPORATION"] },
  { code: "45-47", biz_kinds: ["INDIVIDUAL"] },
  { code: "80", biz_kinds: ["ID_NUMBER_ORG", "INDIVIDUAL"] },
  { code: "82", biz_kinds: ["CORPORATION", "ID_NUMBER_ORG"] },
];

test("regression: worst-case-25 a wrong check digit is held until the user says the certificate prints it so", () => {
  expect(brnNeedsLook({ brn: "0008162516", brnConfirmed: "" })).toBe(true);
  expect(brnNeedsLook({ brn: "0008162516", brnConfirmed: "0008162516" })).toBe(false);
  // Confirming one number never carries to another.
  expect(brnNeedsLook({ brn: "2208162519", brnConfirmed: "0008162516" })).toBe(true);
  expect(brnNeedsLook({ brn: "0000000000", brnConfirmed: "" })).toBe(false);
  expect(brnNeedsLook({ brn: "220816", brnConfirmed: "" })).toBe(false);
});

test("company-37: the number's middle digits name a kind; a corporation cannot open before it is incorporated", () => {
  expect([kindsOfBrn("0008100000", classes), kindsOfBrn("1234567890", classes), kindsOfBrn("1238012345", classes), kindsOfBrn("0000000015", classes), kindsOfBrn("123", classes)]).toEqual([["CORPORATION"], ["INDIVIDUAL"], ["ID_NUMBER_ORG", "INDIVIDUAL"], [], []]);
  const base = { brn: "0008100000", brnConfirmed: "", bizKind: "INDIVIDUAL" as const, openedOn: "", incorporatedOn: "" };
  expect(brnWarnings(base, classes)).toEqual(["kindMismatch"]);
  expect(brnWarnings(base)).toEqual([]); // Missing reference data never implies a kind.
  expect(brnWarnings({ ...base, brn: "2208212345", bizKind: "ID_NUMBER_ORG" }, classes)).toEqual([]);
  expect(brnWarnings({ ...base, bizKind: "CORPORATION", openedOn: "2020-01-01", incorporatedOn: "2020-03-02" }, classes)).toEqual(["openedBeforeIncorporated"]);
  expect(brnWarnings({ ...base, bizKind: "CORPORATION", openedOn: "2020-03-02", incorporatedOn: "2020-03-02" }, classes)).toEqual([]);
});
