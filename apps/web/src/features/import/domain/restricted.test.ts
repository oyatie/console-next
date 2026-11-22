// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import rules from "../../../../../../packages/i18n/src/catalogs/import-restricted-headers.json" with { type: "json" };
import {
  allowedRestrictedTarget,
  allowedTargetsForHeader,
  isAllowedTargetForHeader,
  isDroppedEmployeeImportHeader,
  isPii2RestrictedHeader,
  restrictedKind,
} from "./restricted";
import { draftProblem } from "./mapping";

const AVAILABLE = ["name", "employee_number", "birth_date", "org_unit", "position", "job", "worksite_address", "phone", "rrn"] as const;

test("mirrors backend PII-2 and classification.rs restricted headers", () => {
  for (const hit of ["SSN", "employee_ssn", "RRN", "Phone", "MobilePhone", "mobile", "BaseSalary", "hourly_wage", "BankAccount", "account_no", "bank", "s_s_n", "b-a-n-k"]) {
    expect(isPii2RestrictedHeader(hit), hit).toBe(true);
  }
  for (const miss of ["employee_number", "employee_name", "worksite_address", "workplace_name", "leave_balance", "branch_name", "check_in"]) {
    expect(isPii2RestrictedHeader(miss), miss).toBe(false);
  }

  expect(isDroppedEmployeeImportHeader("birth_date")).toBe(false);
  expect(isDroppedEmployeeImportHeader("worksite_address")).toBe(false);
  expect(isDroppedEmployeeImportHeader("name")).toBe(false);

  for (const fragment of rules.restrictedFragmentsKo) {
    if (allowedRestrictedTarget(fragment) === "phone") {
      expect(isDroppedEmployeeImportHeader(`${fragment}_custom`)).toBe(true);
    } else {
      expect(isDroppedEmployeeImportHeader(fragment), fragment).toBe(true);
    }
  }
});

test("restricts target options for restricted headers while allowing governed rrn/phone", () => {
  const koRrn = rules.rrnAliases.find((a) => (a.codePointAt(0) ?? 0) > 127) ?? "rrn";
  const koPhone = rules.phoneAliases.find((a) => (a.codePointAt(0) ?? 0) > 127) ?? "phone";

  expect(allowedRestrictedTarget("account_no")).toBeNull();
  expect(allowedRestrictedTarget("salary")).toBeNull();
  expect(allowedRestrictedTarget("rrn")).toBe("rrn");
  expect(allowedRestrictedTarget(koRrn)).toBe("rrn");
  expect(allowedRestrictedTarget("mobile")).toBe("phone");
  expect(allowedRestrictedTarget(koPhone)).toBe("phone");

  expect(restrictedKind("salary")).toBe("unmapped");
  expect(restrictedKind("rrn")).toBe("rrn");
  expect(restrictedKind("mobile")).toBe("phone");
  expect(restrictedKind("position")).toBeNull();

  expect(allowedTargetsForHeader("salary", AVAILABLE)).toEqual([]);
  expect(allowedTargetsForHeader("account_no", AVAILABLE)).toEqual([]);
  expect(allowedTargetsForHeader(rules.pii2AddrFragmentKo, AVAILABLE)).toEqual([]);
  expect(allowedTargetsForHeader("rrn", AVAILABLE)).toEqual(["rrn"]);
  expect(allowedTargetsForHeader("mobile", AVAILABLE)).toEqual(["phone"]);
  expect(allowedTargetsForHeader("employee_name", AVAILABLE)).toEqual([...AVAILABLE]);
  expect(allowedTargetsForHeader("birth_date", AVAILABLE)).toEqual([...AVAILABLE]);

  expect(isAllowedTargetForHeader("salary", null)).toBe(true);
  expect(isAllowedTargetForHeader("salary", "job")).toBe(false);
  expect(isAllowedTargetForHeader("rrn", "position")).toBe(false);
  expect(isAllowedTargetForHeader("rrn", "rrn")).toBe(true);
});

test("draftProblem flags disallowed restricted column bindings", () => {
  expect(
    draftProblem({
      header_row: 1,
      skip: false,
      columns: [
        { column: "A", label: "name", target: "name" },
        { column: "B", label: "salary", target: "job" },
      ],
    }),
  ).toBe("restricted");
  expect(
    draftProblem({
      header_row: 1,
      skip: false,
      columns: [
        { column: "A", label: "name", target: "name" },
        { column: "B", label: "salary", target: null },
        { column: "C", label: "rrn", target: "rrn" },
      ],
    }),
  ).toBeNull();
});
