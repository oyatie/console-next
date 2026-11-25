// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { i18n, loadCatalog, LOCALES, t } from "@console/i18n";
import { expect, test } from "vitest";
import { koAttendanceRecords } from "../../../../../packages/i18n/src/catalogs/ko/attendance-records";
import { enAttendanceRecords } from "../../../../../packages/i18n/src/catalogs/en/attendance-records";
import type { DraftCode } from "./domain/grammar";
import { dateText, dayPaneHead, refusalText } from "./present";

test("every parser and cell refusal has its own copy in both locales", async () => {
  const parseCodes = {
    overtime_typed: true, entry_unreadable: true, overnight_without_marker: true,
    span_too_long: true, spans_overlap: true, status_is_derived: true,
    hours_without_times: true, excel_fraction: true, code_ambiguous: true,
    activity_not_stored: true,
    schedule_change_needed: true, already_day_off: true, no_shift_to_copy: true,
    clock_out_only_not_stored: true, leave_not_stored: true,
  } satisfies Record<DraftCode, true>;
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

test("the person-day pane head names the mode and whose day it is", async () => {
  await loadCatalog("ko");
  const person = { name: "Person", employee_number: "E-1" };
  const view = t("attendanceRecords.day.title", { date: dateText("2026-10-06") });
  expect(dayPaneHead("view", "2026-10-06", person)).toEqual({ label: view, title: view, meta: "Person E-1" });
  expect(dayPaneHead("correct", "2026-10-06", person)).toEqual({ label: t("attendanceRecords.correct.title"), title: t("attendanceRecords.correct.title"), meta: `Person · ${dateText("2026-10-06")}` });
  expect(dayPaneHead("void", "2026-10-06")).toEqual({ label: t("attendanceRecords.void.title"), title: t("attendanceRecords.void.title"), meta: undefined });
});
