// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { loadCatalog, t } from "../index";

test("calendar years do not receive digit grouping", async () => {
  await loadCatalog("ko");
  expect(t("attendanceHolidays.holidays.none", { year: 2026 })).toContain("2026년");
  await loadCatalog("en");
  expect(t("attendanceHolidays.holidays.none", { year: 2026 })).toContain("2026");
  expect(t("attendanceHolidays.holidays.none", { year: 2026 })).not.toContain("2,026");
});
