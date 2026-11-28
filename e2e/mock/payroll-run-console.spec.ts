// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtMonth, fmtNumber } from "@console/i18n/format";
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
  await mockRoute(page, "get", "/api/v1/payroll/reference/rates", {
    status: 200,
    json: saeonPayrollRates(),
  });
  await mockRoute(page, "get", "/api/v1/payroll/runs/{id}", request => {
    const query = new URL(request.url()).searchParams;
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 50);
    const missing_bank_only = query.get("missing_bank_only") === "true";
    const q = query.get("q") ?? undefined;
    return { status: 200, json: saeonPayrollRunDetail({ offset, limit, missing_bank_only, q }) };
  });

  return { fixture, runId, initialDetail, groups };
}

for (const width of [1440, 1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /payroll/runs/$id renders P6 RegisterTotals with 18-col register, totals, blockers, preview, and status bar at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const { fixture, runId } = await setupSaeonPayrollRun(page, theme);
      const writes: string[] = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname.startsWith("/api/v1/payroll/") && request.method() !== "GET") writes.push(request.url());
      });
      try {
        await page.goto(`/payroll/runs/${runId}`);
        const root = page.locator('[data-pattern="register-totals"]');
        await expect(root).toBeVisible();
        const expectedGroupLabel = `${saeonUniverse.entities[0]!.name.replace(/^\([^)]+\)|\([^)]+\)$/g, "").trim()} ${t("payroll.group")}`;
        await expect(root.getByRole("heading", { level: 1 })).toHaveText(t("payroll.title"));
        await expect(root).toContainText(`${expectedGroupLabel} · ${fmtMonth("2026-10")}`);
        await expect(root).toContainText("2,514,380,000");
        await expect(root).toContainText("412,906,300");
        await expect(root).toContainText("2,101,473,700");
        await expect(root).toContainText(t("payroll.run.unreviewedBadge"));
        await expect(root).toContainText(t("payroll.run.openCard"));
        await expect(root.getByRole("button", { name: t("payroll.run.requestApproval"), exact: true })).toBeVisible();
        await expect(root).toContainText(saeonUniverse.hero.employeeNumber);
        await expect(root).toContainText(saeonUniverse.payrollRun.windowRows[0]!.place);
        await expect(root).toContainText(`${saeonUniverse.hero.gradeLabel} \u00B7 ${saeonUniverse.hero.roleLabel}`);
        await expect(root).toContainText(t("payroll.run.taxExempt"));
        await expect(root).toContainText(t("payroll.run.taxablePay"));
        await expect(root).toContainText(t("payroll.run.taxableDetail"));
        await expect(root).toContainText("3,367,000");
        await expect(root).toContainText(t("payroll.run.attendanceHolidaySplit", { worked: 18, holiday: 4 }));
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
        await expect(table.locator("tfoot")).toContainText("34,100,000");
        await expect(table.locator("tfoot")).toContainText("605,800");
        await expect(table.locator("tfoot")).toContainText("2,000,000");
        await expect(table).toContainText("32,322,528");

        const missingBankRow = table.locator("tbody tr[data-id]").nth(4);
        await expect(missingBankRow).not.toHaveAttribute("data-tone", /.+/);
        await expect(missingBankRow.locator('td[data-cell-tone="danger"]')).toHaveCount(1);

        if (width >= 1280) {
          await table.locator("tbody tr[data-id]").first().locator("label.check").click();
          const visibilityAtWidth = await page.evaluate(
            ({ vw, netHeaderLabel, precheckTitle }) => {
              const ths = [...document.querySelectorAll<HTMLElement>('table[role="grid"] thead tr:last-child th')];
              const netTh = ths.find(th => th.textContent?.trim() === netHeaderLabel);
              const firstNetTd = document.querySelector<HTMLElement>('table[role="grid"] tbody tr:first-child td[data-pin="end"]');
              const footNetTd = document.querySelector<HTMLElement>('table[role="grid"] tfoot [data-pin="end"]');
              const blocker = [...document.querySelectorAll<HTMLElement>("[data-pattern='register-totals'] bdi")].find(
                el => el.textContent?.trim() === precheckTitle,
              );
              const inView = (el: HTMLElement | null | undefined) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.left >= 0 && r.right <= vw + 1;
              };
              return {
                netHeaderInView: inView(netTh),
                firstNetCellInView: inView(firstNetTd),
                footSubtotalNetInView: inView(footNetTd),
                blockerInView: inView(blocker),
              };
            },
            {
              vw: width,
              netHeaderLabel: t("payroll.run.col.netPay"),
              precheckTitle: t("payroll.run.precheckTitle"),
            },
          );
          expect(visibilityAtWidth).toEqual({
            netHeaderInView: true,
            firstNetCellInView: true,
            footSubtotalNetInView: true,
            blockerInView: true,
          });
        }

        const groupSelectLabel = expectedGroupLabel;
        const groupSelectButton = root.getByRole("button", { name: new RegExp(t("payroll.group")) });
        await expect(groupSelectButton).toBeVisible();
        await expect(groupSelectButton).toHaveAttribute("aria-haspopup", "listbox");
        await expect(groupSelectButton).toContainText(groupSelectLabel);
        const selectBoxes = await root.locator("select").evaluateAll(els =>
          els.map(el => {
            const hiddenParent = el.closest('[aria-hidden="true"]');
            return {
              hidden: Boolean(hiddenParent),
              wrapperWidth: hiddenParent ? Math.round(hiddenParent.getBoundingClientRect().width) : Math.round(el.getBoundingClientRect().width),
            };
          }),
        );
        for (const box of selectBoxes) {
          expect(box.hidden && box.wrapperWidth <= 2).toBe(true);
        }
        if (width === 1440) {
          await groupSelectButton.click();
          const listbox = page.getByRole("listbox", { name: t("payroll.group") });
          await expect(listbox).toBeVisible();
          await expect(listbox.getByRole("option", { name: groupSelectLabel })).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(listbox).toHaveCount(0);
        }

        if (width === 390) {
          const previewHeading = root.getByRole("heading", { name: t("payroll.run.previewTitle"), exact: true });
          const previewClipped = await previewHeading.evaluate(el => el.scrollWidth > el.clientWidth + 1);
          expect(previewClipped).toBe(false);

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

    await table.locator("tbody tr[data-id]").nth(0).locator("label.check").click();
    await table.locator("tbody tr[data-id]").nth(1).locator("label.check").click();
    await expect(page.getByText(t("payroll.run.statusSelectedNet", { amount: fmtNumber(3_141_755 + 2_592_892) }))).toBeVisible();

    await root.getByRole("button", { name: t("payroll.run.viewCount", { count: 2 }), exact: true }).click();
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(2);
    await expect(root).toContainText(t("payroll.run.personCount", { count: 757 }));
    await expect(page.getByText(t("payroll.run.statusTarget", { count: 757 }))).toBeVisible();
    await expect(
      root
        .getByRole("group", { name: t("payroll.run.filterLabel"), exact: true })
        .getByRole("button", { name: new RegExp(t("home.inbox.filter.all")) }),
    ).toContainText("757");

    await root
      .getByRole("group", { name: t("payroll.run.filterLabel"), exact: true })
      .getByRole("button", { name: new RegExp(t("home.inbox.filter.all")) })
      .click();
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);

    await root.getByRole("searchbox", { name: t("payroll.run.findPlaceholder"), exact: true }).fill(saeonUniverse.hero.name);
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);
    await root.getByRole("searchbox", { name: t("payroll.run.findPlaceholder"), exact: true }).fill(saeonUniverse.hero.employeeNumber);
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);
    await root.getByRole("searchbox", { name: t("payroll.run.findPlaceholder"), exact: true }).fill("NO_SUCH_EMPLOYEE_99999");
    await expect(root).toContainText(t("payroll.run.noMatch"));
    await expect(root.getByRole("button", { name: t("payroll.run.nextPage", { count: 50 }), exact: true })).toHaveCount(0);
    await root.getByRole("button", { name: t("payroll.run.resetFilter"), exact: true }).click();
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

test("Baseline /payroll/runs/$id never calls payroll reference rates when lines are non-empty", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(expKey => {
    localStorage.setItem(expKey, "baseline");
    localStorage.setItem("console.locale", "ko");
  }, EXPERIENCE_KEY);
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  const groups = saeonPayGroups();
  const detail = saeonPayrollRunDetail({ offset: 0, limit: 50 });
  const runId = detail.run.id;
  const rateRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.includes("/api/v1/payroll/reference/rates")) {
      rateRequests.push(request.url());
    }
  });
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/onboarding/modules", {
    status: 200,
    json: [...modules.ready, { key: "payroll", ready: true, unblock: null }],
  });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess(`/payroll/runs/${runId}`) });
  await mockRoute(page, "get", "/api/v1/payroll/pay-groups", { status: 200, json: groups });
  await mockRoute(page, "get", "/api/v1/payroll/runs/{id}", { status: 200, json: detail });

  try {
    expect(detail.lines.length).toBeGreaterThan(0);
    await page.goto(`/payroll/runs/${runId}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("list", { name: t("payroll.stages.title") })).toBeVisible();
    await expect(page.locator('[data-pattern="register-totals"]')).toHaveCount(0);
    expect(rateRequests).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("Console /payroll/runs/$id handles attention filter without loop when missing_bank_account_count is 0 and line has ACCOUNT_VERIFICATION", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, runId } = await setupSaeonPayrollRun(page, "light");
  const pageErrors: string[] = [];
  page.on("pageerror", err => pageErrors.push(err.message));

  const base = saeonPayrollRunDetail({ offset: 0, limit: 50 });
  const modifiedLines = base.lines.map((line, index) =>
    index === 0
      ? {
          ...line,
          bank_account_registered: true,
          calculation_status: "BLOCKED_LEGAL_GATE" as const,
          blockers: ["ACCOUNT_VERIFICATION"],
        }
      : {
          ...line,
          bank_account_registered: true,
          calculation_status: "READY_FOR_REVIEW" as const,
          blockers: [],
        },
  );
  const runRequests: string[] = [];
  await page.route(`**/api/v1/payroll/runs/${runId}*`, route => {
    runRequests.push(route.request().url());
    return route.fulfill({
      json: {
        ...base,
        lines: modifiedLines,
        lines_total: modifiedLines.length,
        missing_bank_account_count: 0,
        exceptions_open: 1,
        exceptions_total: 1,
      },
    });
  });

  try {
    await page.goto(`/payroll/runs/${runId}`);
    const root = page.locator('[data-pattern="register-totals"]');
    const table = root.getByRole("grid", { name: t("payroll.run.registerLabel"), exact: true });
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);
    expect(runRequests).toHaveLength(1);

    const filterGroup = root.getByRole("group", { name: t("payroll.run.filterLabel"), exact: true });
    const attentionTab = filterGroup.getByRole("button", { name: new RegExp(t("payroll.run.attentionFilter")) });
    await expect(attentionTab).toContainText("1");
    await attentionTab.click();

    await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);
    await expect(table.locator("tbody tr[data-id]").first()).toContainText(modifiedLines[0]!.employee_display_name);
    await page.waitForTimeout(250);
    expect(runRequests).toHaveLength(1);
    expect(pageErrors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("Console /payroll/runs/$id avoids noMatch flicker and keeps preview visible during IME composition, delayed search, and delayed missing_bank_only from page 3", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, runId, initialDetail } = await setupSaeonPayrollRun(page, "light");
  const page1Ids = new Set(initialDetail.lines.map(l => l.id));
  const page2Detail = saeonPayrollRunDetail({ offset: 10, limit: 50 });
  const page2OnlyEmployee = page2Detail.lines.find(l => !page1Ids.has(l.id))!;

  let delayNextFilter = false;
  await page.route(`**/api/v1/payroll/runs/${runId}*`, async route => {
    const query = new URL(route.request().url()).searchParams;
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 50);
    const missing_bank_only = query.get("missing_bank_only") === "true";
    const q = query.get("q") ?? undefined;
    if (delayNextFilter && (q || missing_bank_only)) {
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    if (page.isClosed()) return;
    return route.fulfill({ json: saeonPayrollRunDetail({ offset, limit, missing_bank_only, q }) });
  });

  try {
    await page.goto(`/payroll/runs/${runId}`);
    const root = page.locator('[data-pattern="register-totals"]');
    const table = root.getByRole("grid", { name: t("payroll.run.registerLabel"), exact: true });
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);

    await page.evaluate(
      ({ noMatchText, previewTitleText }) => {
        const target = document.querySelector('[data-pattern="register-totals"]');
        if (!target) throw new Error("missing register-totals root");
        const events: string[] = [];
        const recordIfBad = () => {
          const text = target.textContent ?? "";
          if (text.includes(noMatchText)) events.push("NO_MATCH_FLASH");
          const hasPreview = [...target.querySelectorAll("h2, h3")].some(el => el.textContent?.trim() === previewTitleText);
          if (!hasPreview) events.push("PREVIEW_DISAPPEARED");
        };
        const obs = new MutationObserver(recordIfBad);
        obs.observe(target, { childList: true, subtree: true, characterData: true });
        (window as unknown as { __flickerEvents: string[]; __stopFlickerObs: () => void }).__flickerEvents = events;
        (window as unknown as { __stopFlickerObs: () => void }).__stopFlickerObs = () => obs.disconnect();
      },
      { noMatchText: t("payroll.run.noMatch"), previewTitleText: t("payroll.run.previewTitle") },
    );

    const jamo = saeonUniverse.hero.name.normalize("NFD").slice(0, 1);
    const searchbox = root.getByRole("searchbox", { name: t("payroll.run.findPlaceholder"), exact: true });
    await searchbox.evaluate((el, val) => {
      const input = el as HTMLInputElement;
      input.focus();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, jamo);
    await page.waitForTimeout(150);
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);
    await searchbox.evaluate(el => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    delayNextFilter = true;
    await searchbox.fill(page2OnlyEmployee.employee_display_name);
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(1);
    await expect(table.locator("tbody tr[data-id]").first()).toContainText(page2OnlyEmployee.employee_display_name);
    await searchbox.fill("");
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(10);

    await root.getByRole("button", { name: t("payroll.run.nextPage", { count: 50 }), exact: true }).click();
    await expect(root).toContainText(t("payroll.run.range", { from: 11, to: 60, total: 757 }));
    await root.getByRole("button", { name: t("payroll.run.nextPage", { count: 50 }), exact: true }).click();
    await expect(root).toContainText(t("payroll.run.range", { from: 61, to: 110, total: 757 }));

    await root.getByRole("button", { name: t("payroll.run.viewCount", { count: 2 }), exact: true }).click();
    await expect(table.locator("tbody tr[data-id]")).toHaveCount(2);

    const flickerEvents = await page.evaluate(() => {
      const w = window as unknown as { __flickerEvents: string[]; __stopFlickerObs: () => void };
      w.__stopFlickerObs();
      return w.__flickerEvents;
    });
    expect(flickerEvents).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("Console /payroll/runs/$id keeps close-blocking attendance warning and pinned net pay visible at 1280px when run is STAGED", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { fixture, runId, initialDetail } = await setupSaeonPayrollRun(page, "light");
  await mockRoute(page, "get", "/api/v1/payroll/runs/{id}", {
    status: 200,
    json: {
      ...initialDetail,
      run: { ...initialDetail.run, status: "STAGED" },
      missing_bank_account_count: 0,
      exceptions_open: 0,
      exceptions_total: 0,
      calculation: initialDetail.calculation ? { ...initialDetail.calculation, payable: true, blocked_lines: 0 } : null,
      lines: initialDetail.lines.map(line => ({
        ...line,
        bank_account_registered: true,
        calculation_status: "READY_FOR_REVIEW" as const,
        blockers: [],
      })),
    },
  });
  try {
    await page.goto(`/payroll/runs/${runId}`);
    const root = page.locator('[data-pattern="register-totals"]');
    await expect(root).toBeVisible();
    await expect(root).toContainText(t("payroll.run.attendanceNotClosedChip"));
    await expect(root).toContainText(t("payroll.run.attendanceNotClosedNote"));
    const check = await page.evaluate(
      ({ chipLabel, netLabel }) => {
        const chip = [...document.querySelectorAll<HTMLElement>("[data-pattern='register-totals'] .chip")].find(
          el => el.textContent?.trim() === chipLabel,
        );
        const netTh = [...document.querySelectorAll<HTMLElement>('table[role="grid"] thead tr:last-child th')].find(
          th => th.textContent?.trim() === netLabel,
        );
        const chipRect = chip?.getBoundingClientRect();
        const netRect = netTh?.getBoundingClientRect();
        return {
          chipVisible: Boolean(chipRect && chipRect.width > 0 && chipRect.right <= 1280 && chipRect.bottom <= 800),
          netVisible: Boolean(netRect && netRect.width > 0 && netRect.right <= 1280),
        };
      },
      {
        chipLabel: t("payroll.run.attendanceNotClosedChip"),
        netLabel: t("payroll.run.col.netPay"),
      },
    );
    expect(check).toEqual({ chipVisible: true, netVisible: true });
    await fits(page, "payroll-run-console/1280-staged");
    await expectAxe(page, "payroll-run-console/1280-staged");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});
