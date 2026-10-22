// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { i18n, loadCatalog, LOCALES } from "@console/i18n";
import { expect, test } from "vitest";
import { koAttendanceRecords } from "../../../../../packages/i18n/src/catalogs/ko/attendance-records";
import { enAttendanceRecords } from "../../../../../packages/i18n/src/catalogs/en/attendance-records";
import type { ParseCode } from "./domain/grammar";
import { refusalText } from "./present";

test("every parser and cell refusal has its own copy in both locales", async () => {
  const parseCodes = {
    overtime_typed: true, entry_unreadable: true, overnight_without_marker: true,
    span_too_long: true, spans_overlap: true, status_is_derived: true,
    hours_without_times: true, excel_fraction: true, code_ambiguous: true,
    activity_not_stored: true,
  } satisfies Record<ParseCode, true>;
  const codes = new Set(Object.keys(parseCodes));
  for (const file of ["grammar.rs", "mod.rs"]) {
    const source = readFileSync(new URL(`../../../../../backend/crates/attendance/domain/src/records/${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/=> "([a-z_]+)"/g)) codes.add(match[1]!);
  }
  const previous = i18n.locale;
  try {
    for (const locale of LOCALES) {
      await loadCatalog(locale);
      i18n.set(locale);
      const catalog: Record<string, string | undefined> = locale === "ko" ? koAttendanceRecords : enAttendanceRecords;
      for (const code of codes) {
        const copy = catalog[`attendanceRecords.refusal.${code}`];
        expect(copy, `${locale}: ${code}`).toBeTruthy();
        expect(refusalText(code), `${locale}: ${code}`).toBe(copy);
      }
    }
  } finally {
    i18n.set(previous);
  }
});
