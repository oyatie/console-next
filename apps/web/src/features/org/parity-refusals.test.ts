// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { ApiError } from "@console/api";
import { i18n, isMessageId, loadCatalog, t } from "@console/i18n";
import { koCommon } from "../../../../../packages/i18n/src/catalogs/ko/common";
import { enCommon } from "../../../../../packages/i18n/src/catalogs/en/common";
import { failureText, readFailureText } from "../../lib/refusal";

const codes = [
  "bulk_register_facts_refused", "bulk_selection_changed", "correction_required",
  "employee_correction_unavailable", "employee_merged", "employee_not_exited",
  "employee_number_in_use", "employee_profile_missing", "exit_case_owns_exit_date",
  "exit_case_owns_exit_reason", "exit_date_needs_exit", "import_not_applied",
  "legacy_import_removed",
  "photo_upload_missing", "photo_upload_not_found", "photo_upload_size_mismatch",
  "photo_upload_unconfirmed", "precondition_missing", "record_import_plan_changed",
  "record_purpose_required", "record_restricted_export_unavailable",
  "record_restricted_forbidden", "record_restricted_self", "record_section_disabled",
  "record_single_entry_exists", "record_version_conflict", "rehire_requires_exited",
] as const;

test("refusal recovery uses the screen's restricted-item and import-review terms", () => {
  expect(koCommon["common.failed.code.import_not_applied"]).toContain("이관 확인");
  expect(koCommon["common.failed.code.record_purpose_required"]).toContain("목적을 선택");
  expect(koCommon["common.failed.code.precondition_missing"]).not.toContain("인사카드");
  for (const code of ["record_purpose_required", "record_restricted_export_unavailable", "record_restricted_self"] as const) {
    expect(koCommon[`common.failed.code.${code}`]).toContain("제한 항목");
    expect(koCommon[`common.failed.code.${code}`]).not.toContain("민감한");
  }
  expect(enCommon["common.failed.code.record_purpose_required"]).toContain("Select a purpose");
});

for (const locale of ["ko", "en"] as const) test.each(codes)(`org/HR refusal %s has its own ${locale} recovery copy`, async code => {
  await loadCatalog(locale);
  i18n.set(locale);
  try {
    const key = `common.failed.code.${code}`;
    const catalog: Record<string, string> = locale === "ko" ? koCommon : enCommon;
    expect(catalog[key]).toBeTruthy();
    expect(isMessageId(key)).toBe(true);
    if (!isMessageId(key)) throw new Error(`Missing catalog key: ${key}`);
    expect(t(key)).toBe(catalog[key]);
    const error = new ApiError(409, code, "Untranslated server message");
    expect(failureText(error)).toBe(catalog[key]);
    expect(readFailureText(error)).toBe(catalog[key]);
    expect(t(key)).not.toContain(code);
  } finally { i18n.set("ko"); }
});
