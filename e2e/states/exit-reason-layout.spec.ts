// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { routeReady } from "../flows";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { exitReasons } from "../mock/reasons";
import { expectAxe, fits } from "../a11y";
import { AT, authz, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

for (const step of ["report", "confirm"] as const) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`exit ${step} reasons keep their layout after input at ${width}px ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    await page.addInitScript(recordShifts);
    const screen = lifecycleSheetScreens[0];
    const fixture = await mockScreen(page, screen, "populated");
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [
      ...authz.capabilities,
      ...["employee_directory_manage", "exit_case_report", "exit_case_hr_confirm"].map(feature => ({ feature, permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false })),
    ] } });
    const c: components["schemas"]["EmployeeExitCase"] = {
      id: id(7000), employee_id: id(4000), employee_name: "배치직원", employee_number: "EXIT-001", company: "화면 검증 회사",
      status: "REPORTED", effective_exit_date: "2026-10-26", site_manager_note: "개인 사정",
      involuntary: false, notice_required: false, dismissal_notice: null, protected_periods: [], reported_by: id(1), reported_by_name: "김보고", reported_at: AT,
      hr_confirmed_by_name: null, hq_confirmed_by_name: null, approval_submitted_by_name: null, closed_by_name: null,
      exit_lifecycle_event_id: null, exit_event_state: null, next_actions: [{ key: "confirm_exit" }],
    };
    await mockRoute(page, "get", "/api/v1/hr/exit-cases", { status: 200, json: { items: step === "confirm" ? [c] : [], total: step === "confirm" ? 1 : 0, offset: 0, limit: 200 } });
    await mockRoute(page, "get", "/api/v1/hr/exit-cases/{id}", { status: 200, json: c });
    await mockRoute(page, "get", "/api/v1/employees/{id}/exit-guards", { status: 200, json: { protected_periods: [], notice_required: false, notice_pay: null, refusal_code: null } });
    await page.route(url => url.pathname === "/api/v1/directory/people", route => route.fulfill({ json: { items: [], total: 0 } }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockRoute(page, "get", "/api/v1/reason-codes", async request => {
      await held;
      const domain = new URL(request.url()).searchParams.get("domain")!;
      return { status: 200, json: { domain, items: domain === "exit_reason" ? exitReasons : [] } };
    });
    try {
      await page.goto(`/people/${id(4000)}?act=${step === "report" ? "exit.report" : `exit.confirm_exit:${c.id}`}`);
      const sheet = page.getByRole("dialog");
      await sheet.evaluate(async () => {
        delete document.documentElement.dataset.fontFallback;
        await document.fonts.load('600 13px "Pretendard Variable Catalog"');
      });
      release();
      await routeReady(page);
      await expect(sheet).toBeVisible();
      const personal = sheet.getByRole("radio", { name: "개인 사정", exact: true });
      await expect(personal).toBeVisible();
      // Audit input after the deliberately held catalogue has populated the form.
      await page.evaluate(clearShifts);
      await expectStable(page, `exit ${step} reasons loaded`);
      const chipLayout = () => sheet.locator('[role="radiogroup"] label').evaluateAll(chips => chips.map(chip => {
        const { x, y, width, height } = chip.getBoundingClientRect();
        const group = chip.closest('[role="radiogroup"]')!.getBoundingClientRect();
        return { text: chip.textContent, x: x - group.x, y: y - group.y, width, height };
      }));
      const before = await chipLayout();
      if (step === "report") {
        await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill("2026-10-26");
        await routeReady(page);
        await expectStable(page, "exit report reasons after date feedback");
        expect(await chipLayout()).toEqual(before);
        await sheet.getByLabel("퇴직 경위").fill("합성 보고");
      }
      await sheet.getByRole("radiogroup").getByText("개인 사정", { exact: true }).click();
      await expect(personal).toBeChecked();
      await routeReady(page);
      await expectStable(page, `exit ${step} reasons after input`);
      expect(await chipLayout()).toEqual(before);
      await fits(page, `exit-${step}/${width}/${theme}`);
      await expectAxe(page, `exit-${step}/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("exit-reasons.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}
