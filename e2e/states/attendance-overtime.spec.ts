// SPDX-License-Identifier: LicenseRef-Proprietary
import { test } from "@playwright/test";
import { loadCatalog } from "@console/i18n";
import { attendanceScreens, type AttendanceState } from "./attendance";
import { attendanceReadState } from "./attendance-helpers";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of attendanceScreens.filter(screen => screen.key === "attendance-overtime")) for (const state of Object.keys(screen.states) as AttendanceState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await attendanceReadState(page, screen, state, width);
  });
}
