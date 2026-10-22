// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { accountLabel } from "./present";

beforeAll(() => loadCatalog("ko"));

test("same-name accounts without employee records have different masked sign-in labels", () => {
  const a = { id: "a", display_name: "Namesake", employee_number: null, sign_in_id: "worker1234@example.test" };
  const b = { ...a, id: "b", sign_in_id: "worker5678@example.test" };
  expect(accountLabel(a, a.id)).toBe("Namesake · w••••1234@example.test");
  expect(accountLabel(b, b.id)).toBe("Namesake · w••••5678@example.test");
});

test("missing employee number uses primary placement, and missing all facts uses the stable account id", () => {
  expect(accountLabel({ id: "a", display_name: "Person", employee_number: " ", employee_company: "Company", employee_org_unit: "HR" }, "a")).toBe("Person · Company · HR");
  expect(accountLabel({ id: "account-id", display_name: "Person", employee_number: null }, "account-id")).toBe("Person · account-id");
});

test("an empty name never leaves an empty interpolation", () => {
  expect(accountLabel({ id: "a", display_name: "  ", employee_number: "E-1" }, "a")).toBe("이름 없음 · E-1");
});
