// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { personLabel, personName } from "./present";

beforeAll(() => loadCatalog("ko"));

test("person names share a blank-aware catalog fallback", () => {
  for (const name of [null, undefined, "", "   "]) expect(personName(name)).toBe("이름 미등록");
  expect(personName(" 박관리자 ")).toBe("박관리자");
  expect(personName("", "Name not set")).toBe("Name not set");
});
const a = { id: "account-a", employee_id: "person-a", display_name: "Namesake", employee_number: "E-1", employee_org_unit: "HR" };

test("same names are marked only for distinct people, retaining number and primary placement", () => {
  const b = { ...a, id: "account-b", employee_id: "person-b", employee_number: "E-2" };
  expect(personLabel(a, [a, b])).toEqual({ name: "Namesake", detail: "E-1 · HR", text: "Namesake · E-1 · HR", sameName: true });
  expect(personLabel(a, [a, { ...a, id: "reissued" }]).sameName).toBe(false);
  expect(personLabel(a, [a, { ...b, display_name: "Other" }]).sameName).toBe(false);
});

test("whitespace and canonical spelling cannot hide a namesake", () => {
  const first = { id: "a", name: "Jos\u00e9" };
  expect(personLabel(first, [first, { id: "b", name: " Jose\u0301 " }]).sameName).toBe(true);
});

test("missing number uses placement; blank facts, short or malformed sign-in IDs always have a safe fallback", () => {
  expect(personLabel({ id: "a", name: "Person", employee_number: " ", company: "Company", org_unit: "HR" }).detail).toBe("Company · HR");
  expect(personLabel({ id: "a", name: "Person", sign_in_id: "ab@example.test" }).detail).toBe("a••••@example.test");
  for (const sign_in_id of ["invalid", "@example.test", "login@"]) {
    expect(personLabel({ id: "a", name: "Person", sign_in_id }).detail).toBe("a");
  }
  expect(personLabel({ id: "a", name: " ", employee_number: " " }).text).toBe(`${t("people.label.unnamed")} · a`);
});

test("colliding masks or identical employee facts remain distinguishable by stable id", () => {
  const first = { id: "a", name: "Person", sign_in_id: "worker1234@example.test" };
  const second = { ...first, id: "b", sign_in_id: "writer1234@example.test" };
  expect(personLabel(first, [first, second]).detail).toBe("w••••1234@example.test · a");
  expect(personLabel(second, [first, second]).detail).toBe("w••••1234@example.test · b");
  expect(personLabel(a, [a, { ...a, id: "b", employee_id: "other" }]).detail).toBe("E-1 · HR · account-a");
});
