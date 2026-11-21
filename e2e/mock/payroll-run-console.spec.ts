// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { payrollScreens } from "../states/payroll";
import { failure, modules, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import {
  saeonAdminToken,
  saeonAdminUser,
  saeonPayGroups,
  saeonPayrollEmployees,
  saeonPayrollRates,
  saeonPayrollRunDetail,
  saeonUniverse,
} from "./saeon";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function enableConsoleExperience(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ({ expKey, themeValue }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", "ko");
    },
    { expKey: EXPERIENCE_KEY, themeValue: theme },
  );
}

async function setupSaeonPayrollRun(page: Page, theme: "light" | "dark" = "light") {
  await enableConsoleExperience(page, theme);
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  const groups = saeonPayGroups();
  const initialDetail = saeonPayrollRunDetail({ offset: 0, limit: 50 });
  const runId = initialDetail.run.id;

  const payrollAccess = screenAccess(`/payroll/runs/${runId}`);
  const orgAccess = screenAccess("/org");
  const peopleAccess = screenAccess("/people");
  const approvalsAccess = screenAccess("/approvals");
  const attendanceAccess = screenAccess("/attendance");
  const statutoryAccess = screenAccess("/statutory");

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/onboarding/modules", {
    status: 200,
    json: [...modules.ready, { key: "payroll", ready: true, unblock: null }],
  });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: {
      ...payrollAccess,
      entries: [
        ...payrollAccess.entries,
        ...orgAccess.entries,
        ...peopleAccess.entries,
        ...approvalsAccess.entries,
        ...attendanceAccess.entries,
        ...statutoryAccess.entries,
      ],
    },
  });
  await mockRoute(page, "get", "/api/v1/payroll/pay-groups", { status: 200, json: groups });
  await mockRoute(page, "get", "/api/v1/employees", {
    status: 200,
    json: {
      items: saeonPayrollEmployees(),
      total: saeonUniverse.payrollRun.headcount,
      offset: 0,
      limit: 1000,
      next_cursor: null,
    },
  });
  await mockRoute(page, "get", "/api/v1/payroll/reference/rates", {
    status: 200,
    json: saeonPayrollRates(),
  });
  await mockRoute(page, "get", "/api/v1/payroll/runs/{id}", request => {
    const query = new URL(request.url()).searchParams;
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 50);
    return { status: 200, json: saeonPayrollRunDetail({ offset, limit }) };
  });

  return { fixture, runId, initialDetail, groups };
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /payroll/runs/$id renders P6 RegisterTotals with 18-col register, totals, blockers, preview, and status bar at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      const { fixture, runId } = await setupSaeonPayrollRun(page, theme);
      const writes: string[] = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname.startsWith("/api/v1/payroll/") && request.method() !== "GET") writes.push(request.url());
      });
      try {
        await page.goto(`/payroll/runs/${runId}`);
        const root = page.locator('[data-pattern="register-totals"]');
        await expect(root).toBeVisible();
        await expect(root.getByRole("heading", { level: 1 })).toHaveText(t("payroll.title"));
        await expect(root).toContainText("2,514,380,000");
        await expect(root).toContainText("412,906,300");
        await expect(root).toContainText("2,101,473,700");
        await expect(root).toContainText(t("payroll.run.unreviewedBadge"));
        await expect(root).toContainText(t("payroll.run.openCard"));
        await expect(root.getByRole("button", { name: t("payroll.run.requestApproval"), exact: true })).toBeVisible();
        await expect(root).toContainText(saeonUniverse.hero.employeeNumber);
        await expect(root).toContainText(saeonUniverse.payrollRun.windowRows[0]!.place);
        await expect(root).toContainText(`${saeonUniverse.hero.gradeLabel} \u00B7 ${saeonUniverse.hero.roleLabel}`);
        await expect(root).toContainText(t("payroll.run.rateNote.taxable", { rate: "4.5" }));
        await expect(root).toContainText(t("payroll.run.rateNote.taxable", { rate: "3.545" }));
        await expect(root).toContainText(t("payroll.run.rateNote.healthInsurance", { rate: "12.95" }));
        await expect(root).toContainText(t("payroll.run.rateNote.taxable", { rate: "0.9" }));
        await expect(root).toContainText(t("payroll.run.rateNote.simplifiedTax"));
        await expect(root).toContainText(t("payroll.run.rateNote.localIncomeTax", { rate: "10" }));
        await expect(root).toContainText(saeonUniverse.payrollRun.payDate);

        const table = root.getByRole("grid", { name: t("payroll.run.registerLabel"), exact: true });
        await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);
        await expect(table.locator("tfoot tr")).toHaveCount(1);
        await expect(table).toContainText("32,322,528");

        const missingBankRow = table.locator("tbody tr[data-id]").nth(4);
        await expect(missingBankRow).not.toHaveAttribute("data-tone", /.+/);
        await expect(missingBankRow.locator('td[data-cell-tone="danger"]')).toHaveCount(1);

        if (width === 390) {
          const heights = await table.locator("tbody tr[data-id]").evaluateAll(rows =>
            rows.map(row => Math.round(row.getBoundingClientRect().height)),
          );
          for (const h of heights) {
            expect(h).toBeGreaterThanOrEqual(48);
            expect(h).toBeLessThanOrEqual(68);
          }

          const statOverlap = await root.locator("dl").first().evaluate(dl => {
            const boxes = [...dl.querySelectorAll<HTMLElement>("dt, dd")].map(el => ({
              text: el.textContent?.trim() ?? "",
              rect: el.getBoundingClientRect(),
            }));
            for (const box of boxes) {
              if (box.rect.right > window.innerWidth + 0.5) return box.text;
            }
            return null;
          });
          expect(statOverlap).toBeNull();

          await page.setViewportSize({ width: 320, height: 844 });
          await fits(page, `payroll-run-console/320-${theme}`);
          await page.setViewportSize({ width: 390, height: 844 });
        }

        const bleed = await page.evaluate(() => {
          const grid = document.querySelector<HTMLElement>("[data-pane-grid]");
          const main = document.getElementById("main");
          return {
            gridOverflow: grid ? grid.scrollWidth - grid.clientWidth : 0,
            mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
          };
        });
        expect(bleed.gridOverflow).toBeLessThanOrEqual(1);
        expect(bleed.mainOverflow).toBeLessThanOrEqual(1);

        await fits(page, `payroll-run-console/${width}-${theme}`);
        await expectAxe(page, `payroll-run-console/${width}-${theme}`);
        await withFullPage(page, () => shot(page, `${width}-payroll-${theme}`));

        expect(writes).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

test("Console /payroll/runs/$id supports row selection, attention filter, search, pagination, preview toggle, and read-only sheets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, runId } = await setupSaeonPayrollRun(page, "light");
  try {
    await page.goto(`/payroll/runs/${runId}`);
    const root = page.locator('[data-pattern="register-totals"]');
    const table = root.getByRole("grid", { name: t("payroll.run.registerLabel"), exact: true });
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);

    await table.locator("tbody tr[data-id]").nth(4).click();
    await expect(root).toContainText("2,559,000");

    await root.getByRole("button", { name: t("payroll.run.viewCount", { count: 2 }), exact: true }).click();
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);

    await root
      .getByRole("group", { name: t("payroll.run.filterLabel"), exact: true })
      .getByRole("button", { name: new RegExp(t("home.inbox.filter.all")) })
      .click();
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);

    await root.getByRole("searchbox", { name: t("payroll.run.findPlaceholder"), exact: true }).fill(saeonUniverse.hero.name);
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);
    await root.getByRole("searchbox", { name: t("payroll.run.findPlaceholder"), exact: true }).fill(saeonUniverse.hero.employeeNumber);
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);
    await root.getByRole("searchbox", { name: t("payroll.run.findPlaceholder"), exact: true }).fill("");
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);

    await root.getByRole("button", { name: t("payroll.run.nextPage", { count: 50 }), exact: true }).click();
    await expect(root).toContainText(t("payroll.run.range", { from: 11, to: 60, total: 757 }));

    await root.getByRole("button", { name: t("payroll.run.previewToggle"), exact: true }).click();
    await expect(root.getByRole("heading", { name: t("payroll.run.previewTitle"), exact: true })).toHaveCount(0);

    await root.getByRole("button", { name: t("payroll.run.export"), exact: true }).click();
    await expect(page.getByRole("dialog", { name: t("payroll.run.exportSheetTitle") })).toBeVisible();
    await page.getByRole("button", { name: t("common.cancel"), exact: true }).click();

    await root.getByRole("button", { name: t("payroll.run.requestApproval"), exact: true }).click();
    await expect(page.getByRole("dialog", { name: t("payroll.run.submitSheetTitle") })).toBeVisible();
    await page.getByRole("button", { name: t("uiSheet.close"), exact: true }).last().click();

    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

for (const state of ["loading", "empty", "failed", "refused", "missing"] as const) {
  test(`Console /payroll/runs/$id handles ${state} state cleanly`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { fixture, runId, initialDetail } = await setupSaeonPayrollRun(page, "dark");
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    await page.route(`**/api/v1/payroll/runs/${runId}*`, async route => {
      if (state === "loading") await held;
      if (page.isClosed()) return;
      if (state === "empty") {
        return route.fulfill({
          json: {
            ...initialDetail,
            lines: [],
            lines_total: 0,
            exceptions_open: 0,
            exceptions_total: 0,
            calculation: null,
          },
        });
      }
      const status = state === "failed" ? 500 : state === "refused" ? 403 : 404;
      const code = state === "failed" ? "internal_error" : state === "refused" ? "forbidden" : "not_found";
      return route.fulfill({ status, json: failure(code) });
    });
    try {
      await page.goto(`/payroll/runs/${runId}`);
      const root = page.locator('[data-pattern="register-totals"]');
      await expect(root).toBeVisible();
      if (state === "loading") {
        await expect(root.locator('[aria-busy="true"]').last()).toBeVisible();
      } else if (state === "empty") {
        await expect(root).toContainText(t("payroll.run.emptyLines"));
      } else if (state === "refused") {
        await expect(root.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
      } else if (state === "failed") {
        await expect(root.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible({ timeout: 15_000 });
      } else {
        await expect(root).toContainText(t("common.read.notFound.title"));
      }
      await fits(page, `payroll-run-console/${state}`);
      await expectAxe(page, `payroll-run-console/${state}`);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      release();
      fixture.release();
    }
  });
}

test("Console /payroll/runs/$id latches 403 refusal across keepPreviousData pagination", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, runId } = await setupSaeonPayrollRun(page, "light");
  let callCount = 0;
  await page.route(`**/api/v1/payroll/runs/${runId}*`, route => {
    callCount++;
    if (callCount === 1) return route.fulfill({ json: saeonPayrollRunDetail({ offset: 0, limit: 50 }) });
    return route.fulfill({ status: 403, json: failure("forbidden") });
  });
  try {
    await page.goto(`/payroll/runs/${runId}`);
    const root = page.locator('[data-pattern="register-totals"]');
    await expect(root).toContainText(fmtNumber(2_101_473_700));
    await root.getByRole("button", { name: t("payroll.run.nextPage", { count: 50 }), exact: true }).click();
    await expect(root.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible({ timeout: 15_000 });
    await expect(root.getByRole("heading", { name: t("payroll.run.previewTitle"), exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});
