// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
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
  for (const sign_in_id of [undefined, null, "", " ", "invalid", "@example.test", "login@"]) {
    const person = { id: "hidden-account-id", name: "Person", sign_in_id };
    expect(personLabel(person).detail).toBe("식별 정보 없음");
    expect(personLabel(person, [person, { ...person, id: "other-account-id" }]).text).not.toContain(person.id);
  }
  expect(personLabel({ id: "a", name: " ", employee_number: " " }).text).toBe(`${t("people.label.unnamed")} · 식별 정보 없음`);
});

test("colliding masks and employee facts retain the visible namesake warning without raw account ids", () => {
  const first = { id: "a", name: "Person", sign_in_id: "worker1234@example.test" };
  const second = { ...first, id: "b", sign_in_id: "writer1234@example.test" };
  expect(personLabel(first, [first, second])).toMatchObject({ detail: "w••••1234@example.test", sameName: true });
  expect(personLabel(second, [first, second])).toMatchObject({ detail: "w••••1234@example.test", sameName: true });
  expect(personLabel(a, [a, { ...a, id: "b", employee_id: "other" }])).toMatchObject({ detail: "E-1 · HR", sameName: true });
});

test.each(["ko", "en"] as const)("colliding account details use the creation time on the shared detail line in %s", async locale => {
  await loadCatalog(locale);
  const first = { id: "account-a", display_name: "Namesake", sign_in_id: "worker1234@example.test", created_at: "2026-10-01T01:00:00Z" };
  const second = { ...first, id: "account-b", sign_in_id: "writer1234@example.test", created_at: "2026-10-01T02:00:00Z" };
  const peers = [first, second];
  for (const account of peers) {
    const detail = t("people.label.accountCreated", { at: fmtDateTime(account.created_at) });
    expect(personLabel(account, peers)).toEqual({ name: "Namesake", detail, text: `Namesake · ${detail}`, sameName: true });
  }
  expect(personLabel(first, peers).detail).not.toBe(personLabel(second, peers).detail);
  for (const others of [[first], [first, { ...second, display_name: "Other" }], [first, { ...second, employee_number: "E-2" }]]) {
    expect(personLabel(first, others).detail).toBe("w••••1234@example.test");
  }
  expect(personLabel({ ...first, created_at: undefined }, peers).detail).toBe("w••••1234@example.test");
  const placed = peers.map(p => ({ ...p, employee_number: "E-1", employee_company: "Company" }));
  expect(personLabel(placed[0]!, placed).detail).toBe(t("people.label.accountCreated", { at: fmtDateTime(first.created_at) }));
  const employees = peers.map(({ display_name, ...account }) => ({ ...account, name: display_name }));
  expect(personLabel(employees[0]!, employees).detail).toBe("w••••1234@example.test");
  await loadCatalog("ko");
});
