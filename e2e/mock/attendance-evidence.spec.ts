// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { chooseRadio } from "../flows";
import { attendanceBoardScreens } from "../states/attendance";
import { mockScreen } from "./screen";
import { attendancePerson } from "./attendance-board";
import { AT, id } from "./fixtures";

test.beforeAll(() => loadCatalog("ko"));

for (const [kind, text] of [["WORK_OUTPUT", "작업 기록 · 결과물"], ["FUTURE_EVIDENCE", "확인되지 않은 항목"]] as const) {
  test(`source and history tolerate evidence kind ${kind}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
    const screen = attendanceBoardScreens.find(s => s.key === "attendance-day")!;
    const fixture = await mockScreen(page, screen, "populated");
    const entry = { id: id(800), batch_id: id(801), kind: "TIMES", segments: [{ start: 540, end: 1080 }], source: "MANUAL", evidence_kind: kind, undone: false, created_at: AT, created_by_name: "근태담당" };
    const day = { ...attendancePerson.days[0]!, entry };
    await page.route(url => url.pathname === `/api/v1/attendance/people/${id(100)}/month`, route => route.fulfill({ json: { ...attendancePerson, days: [day], history: [{ date: day.date, entry }] } }));
    await page.goto(screen.path);
    await page.getByRole("button", { name: t("attendanceRecords.board.open"), exact: true }).first().click();
    const dock = page.getByRole("dialog");
    for (const tab of ["source", "history"] as const) {
      await dock.getByRole("tab", { name: t(`attendanceRecords.day.tab.${tab}`), exact: true }).click();
      await expect(dock.getByRole("list", { name: t("attendanceRecords.day.historyLabel") })).toContainText(text);
      await expect(dock).not.toContainText("FUTURE_EVIDENCE");
      await expect(dock.getByText(t("attendanceRecords.evidence.OTHER"), { exact: true })).toHaveCount(0);
    }
    await fits(page, `evidence ${kind}`);
    await expectAxe(page, `evidence ${kind}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) {
  test(`work output evidence is chosen explicitly and sent on save at ${width}px ${colorScheme}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    const screen = attendanceBoardScreens.find(s => s.key === "attendance-day")!;
    const fixture = await mockScreen(page, screen, "populated");
    await page.goto(`${screen.path}&detail=true`);
    const input = page.getByRole("textbox", { name: /^근태직원 1 입력/ });
    await input.click();
    await page.keyboard.type("9-18");
    await page.getByRole("button", { name: t("attendanceRecords.toolbar.save"), exact: true }).click();
    const title = t("attendanceRecords.save.title", { count: 1 });
    const dock = page.getByRole("complementary", { name: title }).or(page.getByRole("dialog", { name: title }));
    const choice = dock.getByRole("radio", { name: "작업 기록 · 결과물", exact: true });
    await expect(choice).toHaveCount(1);
    await expect(choice).not.toBeChecked();
    await chooseRadio(dock, /^작업 기록 · 결과물$/);
    await dock.getByRole("textbox", { name: new RegExp(`^${t("attendanceRecords.evidence.note")}`) }).fill("작업 기록 대조");
    await expectAxe(page, `work output ${width} ${colorScheme}`);
    await fits(page, `work output ${width} ${colorScheme}`);
    await testInfo.attach("evidence", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });
    const saved = page.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/attendance/entries");
    await dock.getByRole("button", { name: t("attendanceRecords.save.commit", { count: 1 }), exact: true }).click();
    expect((await saved).postDataJSON().evidence).toEqual({ kind: "WORK_OUTPUT", note: "작업 기록 대조" });
    await expect(dock).not.toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  });
}
