// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { attendanceRoutes } from "./attendance";

const validate = attendanceRoutes[0]!.options.validateSearch as (search: Record<string, unknown>) => { tab?: string; date?: string; month?: string; wp?: string };
test.each(["day", "month", "schedule", "issues", "close", "overtime"])("attendance accepts the %s URL view and preserves coordinates", tab => {
  expect(validate({ tab, date: "2026-10-04", month: "2026-09", wp: "workplace" })).toMatchObject({ tab, date: "2026-10-04", month: "2026-09", wp: "workplace" });
});
test.each([undefined, "unknown", "leave"])("attendance falls back to month for %s", tab => {
  expect(validate({ tab }).tab ?? "month").toBe("month");
});
