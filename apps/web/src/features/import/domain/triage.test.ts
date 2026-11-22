// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import type { ImportPreview, ImportRow } from "./contract";
import {
  filterTriageRows,
  firstActionableRowKey,
  hasMappedSexColumn,
  rowRemediationHintKey,
  rowTriageBucket,
  triageCounts,
} from "./triage";

const mkRow = (over: Partial<ImportRow>): ImportRow => ({
  source_key: `k-${over.row ?? 1}`,
  sheet: "Sheet1",
  row: 1,
  name: "Test Person",
  outcome: "insert",
  ...over,
});

test("separates hard blockers, warnings, and clean ready rows", () => {
  const rows: ImportRow[] = [
    mkRow({ row: 1, outcome: "insert", new_person: { status: "ACTIVE", hire_date: "2024-01-01", migrated_former: false, employee_number: "1001", sex: "MALE" } }),
    mkRow({ row: 2, outcome: "update", deferred: [{ field: "org_unit", route: "lifecycle_transfer" }] }),
    mkRow({ row: 3, outcome: "insert", unit_name: "UnmappedUnit", new_person: { status: "ACTIVE", hire_date: "2024-01-01", migrated_former: false, employee_number: null } }),
    mkRow({ row: 4, outcome: "refused", refusal_code: "invalid_date", refusal_field: "hire_date" }),
    mkRow({ row: 5, outcome: "unresolved_identity" }),
  ];

  expect(triageCounts(rows)).toEqual({ all: 5, valid: 1, warn: 2, blocker: 2 });
  expect(rowTriageBucket(rows[0]!)).toBe("valid");
  expect(rowTriageBucket(rows[1]!)).toBe("warn");
  expect(rowTriageBucket(rows[3]!)).toBe("blocker");
  expect(rowTriageBucket(rows[4]!)).toBe("blocker");
  expect(filterTriageRows(rows, "blocker").map((r) => r.row)).toEqual([4, 5]);
  expect(filterTriageRows(rows, "warn").map((r) => r.row)).toEqual([2, 3]);
  expect(filterTriageRows(rows, "valid").map((r) => r.row)).toEqual([1]);
  expect(firstActionableRowKey({ rows })).toBe("k-4");
});

test("maps invalid_date and status_conflict refusals to explicit remediation hints", () => {
  expect(rowRemediationHintKey(mkRow({ outcome: "refused", refusal_code: "invalid_date" }))).toBe("import.hint.invalid_date");
  expect(rowRemediationHintKey(mkRow({ outcome: "refused", refusal_code: "status_conflict" }))).toBe("import.hint.status_conflict");
  expect(rowRemediationHintKey(mkRow({ outcome: "unresolved_identity" }))).toBe("import.hint.unresolved_identity");
  expect(rowRemediationHintKey(mkRow({ outcome: "insert" }))).toBeNull();
});

test("detects whether sex was explicitly mapped in preview columns for derived-sex hints", () => {
  const withoutSex = { columns: [{ source_header: "rrn", normalized_header: "rrn", classification: "restricted", preview_allowed: false }] } as ImportPreview;
  const withSex = { columns: [{ source_header: "sex", normalized_header: "sex", target: "sex", classification: "canonical", preview_allowed: true }] } as ImportPreview;
  expect(hasMappedSexColumn(withoutSex)).toBe(false);
  expect(hasMappedSexColumn(withSex)).toBe(true);
});
