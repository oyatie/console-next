// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { t } from "@console/i18n";
import { test } from "../locale-fixture";
import { expectAxe, fits } from "../a11y";
import { attendancePerson } from "../mock/attendance-board";
import { AT, failure, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { attendanceBoardScreens } from "./attendance";

const screen = attendanceBoardScreens.find(s => s.key === "attendance-day")!;

for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
  for (const surface of ["save", "correct"] as const) {
    test(`${surface}: refused automatic previews keep typing focus at ${width}px ${theme} @ui-state`, async ({ page }, testInfo) => {
      // The wide save dock leaves the board editable; the narrow dock is a modal.
      await page.setViewportSize({ width: surface === "save" ? 1440 : width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockScreen(page, screen, "populated");
      let previews = 0;
      await mockRoute(page, "post", "/api/v1/attendance/entries/preview", () => {
        previews++;
        return { status: 403, json: failure("forbidden") };
      });
      const entry = { id: id(800), batch_id: id(801), kind: "TIMES" as const, segments: [{ start: 540, end: 1080 }], source: "MANUAL" as const, evidence_kind: "PAPER_SHEET" as const, undone: false, created_at: AT, created_by_name: "근태담당" };
      const day = { ...attendancePerson.days[0]!, entry };
      await mockRoute(page, "get", "/api/v1/attendance/people/{employee_id}/month", { status: 200, json: { ...attendancePerson, days: [day], history: [{ date: day.date, entry }] } });
      await page.goto(surface === "save" ? `${screen.path}&detail=true` : screen.path);
      let input;
      if (surface === "save") {
        await page.getByRole("textbox", { name: /^근태직원 1 입력/ }).fill("9-18");
        await page.getByRole("button", { name: t("attendanceRecords.toolbar.save"), exact: true }).click();
        await expect.poll(() => previews).toBeGreaterThan(0);
        await expect(page.getByRole("alert")).toBeVisible();
        input = page.getByRole("textbox", { name: /^근태직원 2 입력/ });
      } else {
        await page.getByRole("button", { name: t("attendanceRecords.board.open"), exact: true }).first().click();
        await page.getByRole("button", { name: t("attendanceRecords.day.correct"), exact: true }).click();
        input = page.getByRole("textbox", { name: new RegExp(`^${t("attendanceRecords.correct.after")}`) });
      }
      await input.click();
      const before = previews;
      // Slower than the preview debounce: refusals land between individual keystrokes.
      await page.keyboard.type("9-17", { delay: 700 });
      await expect.poll(() => previews).toBeGreaterThan(before);
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("9-17");
      await page.setViewportSize({ width, height: 900 });
      await fits(page, `${surface}/${width}/${theme}`);
      await expectAxe(page, `${surface}/${width}/${theme}`);
      await testInfo.attach("preview-refusal", { body: await page.screenshot({ path: testInfo.outputPath("preview-refusal.png"), animations: "disabled" }), contentType: "image/png" });
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
