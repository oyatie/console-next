// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { AT, authz, id } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

const reasons: components["schemas"]["ReasonCatalogEntry"][] = [
  "PERSONAL", "FAMILY", "ILLNESS", "STUDY", "WORKING_CONDITIONS", "WAGE_ARREARS", "RELOCATION", "CLOSURE", "INSOLVENCY", "ADVISED_RESIGNATION_BUSINESS", "REDUNDANCY_DISMISSAL", "DISCIPLINARY_DISMISSAL", "ADVISED_RESIGNATION_FAULT", "RETIREMENT_AGE", "CONTRACT_END", "PROJECT_END", "COVERAGE_EXCLUDED", "DUAL_EMPLOYMENT", "DEATH", "OTHER",
].map(code => ({ code, system: true, active: true, requires_note: false, involuntary: ["ADVISED_RESIGNATION_BUSINESS", "REDUNDANCY_DISMISSAL", "DISCIPLINARY_DISMISSAL", "ADVISED_RESIGNATION_FAULT"].includes(code), notice_required: code.endsWith("DISMISSAL"), label_ko: null, label_en: null }));

for (const step of ["report", "confirm"] as const) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`exit ${step} reasons keep their first painted layout at ${width}px ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => {
      localStorage.setItem("console.theme", theme);
      const frames: string[] = [];
      Object.assign(window, { reasonFrames: frames });
      const sample = () => {
        const chips = [...document.querySelectorAll('[role="radiogroup"] label')].filter(el => el.querySelector('input[type="radio"]'));
        if (chips.length) frames.push(JSON.stringify(chips.map(el => {
          const { x, y, width, height } = el.getBoundingClientRect();
          const parent = el.closest('[role="radiogroup"]')!.getBoundingClientRect();
          return { text: el.textContent, x: x - parent.x, y: y - parent.y, width, height };
        })));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, theme);
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
      return { status: 200, json: { domain, items: domain === "exit_reason" ? reasons : [] } };
    });
    try {
      await page.goto(`/people/${id(4000)}?act=${step === "report" ? "exit.report" : `exit.confirm_exit:${c.id}`}`);
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();
      await page.evaluate(async () => {
        delete document.documentElement.dataset.fontFallback;
        await document.fonts.load('600 13px "Pretendard Variable Catalog"');
      });
      release();
      const personal = sheet.getByRole("radio", { name: "개인 사정", exact: true });
      await expect(personal).toBeVisible();
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
      const frames = await page.evaluate(() => (window as unknown as { reasonFrames: string[] }).reasonFrames);
      expect(frames.length).toBeGreaterThan(1);
      expect([...new Set(frames)]).toHaveLength(1);
      if (step === "report") {
        await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill("2026-10-26");
        await sheet.getByLabel("퇴직 경위").fill("합성 보고");
      }
      await sheet.getByRole("radiogroup").getByText("개인 사정", { exact: true }).click();
      await expect(personal).toBeChecked();
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
      expect([...new Set(await page.evaluate(() => (window as unknown as { reasonFrames: string[] }).reasonFrames))]).toHaveLength(1);
      await fits(page, `exit-${step}/${width}/${theme}`);
      await expectAxe(page, `exit-${step}/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("exit-reasons.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}
