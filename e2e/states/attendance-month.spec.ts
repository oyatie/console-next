// SPDX-License-Identifier: LicenseRef-Proprietary
import { test } from "@playwright/test";
import { loadCatalog } from "@console/i18n";
import { attendanceBoardScreens, type AttendanceState } from "./attendance";
import { attendanceBoardState, attendanceSheetState } from "./attendance-helpers";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of [attendanceBoardScreens[0], attendanceBoardScreens[2]]) for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceBoardState(page, screen, state, width);
  });
}

for (const state of ["populated", "empty", "failed", "refused", "loading"] as const) for (const width of [1440, 390]) {
  test(`undo sheet ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceSheetState(page, "undo", state, width);
  });
}
