// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { i18n, loadCatalog, t } from "../index";

test.each(["ko", "en"] as const)("%s memo hint takes its limit from the field", async locale => {
  const previous = i18n.locale;
  try {
    await loadCatalog(locale);
    i18n.set(locale);
    const hint = t("attendanceRecords.evidence.note.hint", { limit: 123 });
    expect(hint).toContain("123");
    expect(hint).not.toContain("500");
  } finally {
    i18n.set(previous);
  }
});
