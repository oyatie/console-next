// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { changeLine, historyValue } from "./present";

test.each(["ko", "en"] as const)("%s: director date suffixes are formatted and invalid dates cannot crash history", async (locale) => {
  await loadCatalog(locale);
  i18n.set(locale);
  try {
    const role = locale === "ko" ? "대표이사" : "Representative director";
    for (const [name, shown] of [["김대표 2026-10-15", `김대표 ${fmtDate("2026-10-15")}`], ["김대표 2026-99-99", "김대표 2026-99-99"]]) {
      const stored = `REPRESENTATIVE_DIRECTOR ${name}`;
      const expected = `${role} ${shown}`;
      expect(historyValue("directors", stored)).toBe(expected);
      expect(changeLine({ field: "directors", before: stored, after: stored })).toContain(`: ${expected} → ${expected}`);
    }
  } finally {
    i18n.set("ko");
  }
});

test.each(["ko", "en"] as const)("%s: every role and date in a flattened director list is localized", async (locale) => {
  await loadCatalog(locale);
  i18n.set(locale);
  try {
    const stored = "REPRESENTATIVE_DIRECTOR 김대표 2026-10-15, INSIDE_DIRECTOR 이이사 2026-10-16, AUDITOR 박감사";
    const expected = locale === "ko"
      ? `대표이사 김대표 ${fmtDate("2026-10-15")}, 사내이사 이이사 ${fmtDate("2026-10-16")}, 감사 박감사`
      : `Representative director 김대표 ${fmtDate("2026-10-15")}, Inside director 이이사 ${fmtDate("2026-10-16")}, Auditor 박감사`;
    expect(historyValue("directors", stored)).toBe(expected);
    expect(changeLine({ field: "directors", before: stored, after: stored })).toContain(`: ${expected} → ${expected}`);
    expect(historyValue("directors", "ROLE_FROM_LATER 김대표, AUDITOR 박감사")).toBe(`ROLE_FROM_LATER 김대표, ${locale === "ko" ? "감사" : "Auditor"} 박감사`);
  } finally {
    i18n.set("ko");
  }
});
