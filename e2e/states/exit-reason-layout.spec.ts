// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { routeReady } from "../flows";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { exitReasons } from "../mock/reasons";
import { expectAxe, fits } from "../a11y";
import { AT, authz, id, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { lifecycleSheetScreens } from "./lifecycle-sheets";

test.beforeAll(() => loadCatalog("ko"));

for (const step of ["report", "confirm"] as const) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`exit ${step} reasons keep their layout after input at ${width}px ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem("console.theme", theme), theme);
    await page.addInitScript(recordShifts);
    // Frame geometry catches transient wraps even without LayoutShift entries (Firefox).
    await page.addInitScript(() => {
      const frames: string[] = [];
      Object.assign(window, { exitReasonFrames: frames });
      const sample = () => {
        const chips = [...document.querySelectorAll('[role="dialog"] [role="radiogroup"] label')];
        if (chips.length) frames.push(JSON.stringify(chips.map(chip => {
          const { x, y, width, height } = chip.getBoundingClientRect();
          const group = chip.closest('[role="radiogroup"]')!.getBoundingClientRect();
          return { x: x - group.x, y: y - group.y, width, height };
        })));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const screen = lifecycleSheetScreens[0];
    const fixture = await mockScreen(page, screen, "populated");
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [
      ...authz.capabilities,
      ...["employee_directory_manage", "exit_case_report", "exit_case_hr_confirm"].map(feature => ({ feature, permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false })),
    ] } });
    const c: components["schemas"]["EmployeeExitCase"] = {
      id: id(7000), employee_id: id(4000), employee_name: user.display_name, employee_number: "EXIT-001", company: user.tenant!.name,
      status: "REPORTED", effective_exit_date: "2026-10-26", site_manager_note: "Synthetic report",
      involuntary: false, notice_required: false, dismissal_notice: null, protected_periods: [], reported_by: id(1), reported_by_name: user.display_name, reported_at: AT,
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
        const preload = document.querySelector<HTMLLinkElement>('link[rel="preload"][as="font"][data-ui-font]');
        if (preload) await document.fonts.load(`1em ${JSON.stringify(preload.dataset.uiFont)}`);
      });
      release();
      await routeReady(page);
      await expect(sheet).toBeVisible();
      const personal = sheet.getByRole("radio", { name: t("reason.exit_reason.PERSONAL"), exact: true });
      await expect(personal).toBeVisible();
      // Audit input after the deliberately held catalogue has populated the form.
      await page.evaluate(clearShifts);
      await expectStable(page, `exit ${step} reasons loaded`);
      const expectChipFrames = async () => {
        const frames = await page.evaluate(async () => {
          // Observe the input window in both engines, including deferred feedback.
          await new Promise(resolve => setTimeout(resolve, 500));
          return (window as unknown as { exitReasonFrames: string[] }).exitReasonFrames;
        });
        expect(frames.length).toBeGreaterThan(1);
        expect([...new Set(frames)], "chip geometry must match on every painted frame").toHaveLength(1);
      };
      await expectChipFrames();
      if (step === "report") {
        await sheet.getByRole("textbox", { name: new RegExp(`^${t("exit.field.date")}`) }).fill("2026-10-26");
        await routeReady(page);
        await expectStable(page, "exit report reasons after date feedback");
        await expectChipFrames();
        await sheet.getByLabel(t("exit.field.circumstances")).fill("Synthetic report");
      }
      await sheet.getByRole("radiogroup").getByText(t("reason.exit_reason.PERSONAL"), { exact: true }).click();
      await expect(personal).toBeChecked();
      await routeReady(page);
      await expectStable(page, `exit ${step} reasons after input`);
      await expectChipFrames();
      await fits(page, `exit-${step}/${width}/${theme}`);
      await expectAxe(page, `exit-${step}/${width}/${theme}`);
      await page.screenshot({ path: test.info().outputPath("exit-reasons.png"), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); await page.close(); fixture.release(); }
  });
}
