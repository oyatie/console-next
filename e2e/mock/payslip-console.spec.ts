// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtMonth, fmtNumber } from "@console/i18n/format";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { shot, withFullPage } from "../shots";
import { installFaultClock } from "../states/fault-clock";
import { screens } from "../states/registry";
import { failure, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import {
  saeonHeroPayslipDetail,
  saeonHeroPayslipDocs,
  saeonHeroToken,
  saeonHeroUser,
  saeonPayrollRow,
  saeonUniverse,
} from "./saeon";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

async function setExperience(page: Page, experience: "console" | "baseline", theme: "light" | "dark" = "light") {
  await page.addInitScript(
    ({ expKey, expValue, themeValue }) => {
      localStorage.setItem(expKey, expValue);
      localStorage.setItem("console.theme", themeValue);
      localStorage.setItem("console.locale", "ko");
    },
    { expKey: EXPERIENCE_KEY, expValue: experience, themeValue: theme },
  );
}

async function setupPayslipMock(
  page: Page,
  {
    experience = "console",
    theme = "light",
    listMode = "populated",
    detailMode = "populated",
    faultClock = false,
  }: {
    experience?: "console" | "baseline";
    theme?: "light" | "dark";
    listMode?: "populated" | "empty" | "loading" | "failed" | "refused";
    detailMode?: "populated" | "failed" | "refused" | "not_found";
    faultClock?: boolean;
  } = {},
) {
  await setExperience(page, experience, theme);
  if (listMode !== "failed" && (detailMode === "failed" || faultClock)) {
    await installFaultClock(page);
  }
  const fixture = await mockScreen(page, screens[0], listMode === "failed" ? "failed" : "populated");
  const hero = saeonHeroUser();
  const docs = saeonHeroPayslipDocs();
  const baseAccess = screenAccess("/account");

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonHeroToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: hero });
  await mockRoute(page, "get", "/api/v1/access/me", {
    status: 200,
    json: { ...baseAccess, is_ops: false, entries: [] },
  });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", {
    status: 200,
    json: {
      items: [],
      total: 0,
      total_is_exact: true,
      next_cursor: null,
      unavailable: [],
      counts: {
        turn: { total: 0, total_is_exact: true },
        waiting: { total: 0, total_is_exact: true },
        scheduled: { total: 0, total_is_exact: true },
        failures: { total: 0, total_is_exact: true },
      },
      upcoming: [],
      snooze_presets: [],
      has_work: false,
      quick_starts: [],
      as_of: "2026-11-20T00:00:00Z",
      available_filters: [],
    },
  });

  let releaseList!: () => void;
  const heldList = new Promise<void>(resolve => {
    releaseList = resolve;
  });

  await mockRoute(page, "get", "/api/v1/me/inbox-docs", async () => {
    if (listMode === "loading") await heldList;
    if (listMode === "failed") return { status: 503, json: failure("service_unavailable") };
    if (listMode === "refused") return { status: 403, json: failure("forbidden") };
    if (listMode === "empty") return { status: 200, json: { items: [], next_cursor: null } };
    return { status: 200, json: docs };
  });

  await mockRoute(page, "get", "/api/v1/me/inbox-docs/{id}", request => {
    if (detailMode === "failed") return { status: 503, json: failure("service_unavailable") };
    if (detailMode === "refused") return { status: 403, json: failure("forbidden") };
    if (detailMode === "not_found") return { status: 404, json: failure("not_found") };
    const id = new URL(request.url()).pathname.split("/").at(-1);
    const detail = saeonHeroPayslipDetail(id);
    if (!detail) return { status: 404, json: failure("not_found") };
    return { status: 200, json: detail };
  });

  return {
    fixture,
    hero,
    docs,
    releaseList: () => releaseList?.(),
  };
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console /payslips renders Saeon hero payslip statement and anchored chrome at ${width}px ${theme}`, async ({
      page,
    }) => {
      const height = width === 1440 ? 900 : 844;
      await page.setViewportSize({ width, height });
      const { fixture, hero } = await setupPayslipMock(page, { experience: "console", theme });
      try {
        await page.goto("/payslips");
        const stmt = page.locator('[data-pattern="phone-statement"]');
        await expect(stmt).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        await expect(stmt).toContainText(fmtMonth("2026-10"));
        await expect(stmt).toContainText(`${t("payslip.payDateLabel")} 11-25`);
        await expect(stmt).toContainText(t("payslip.netPay"));
        await expect(stmt).toContainText(t("payslip.netAmount", { amount: fmtNumber(3_141_755) }));
        await expect(stmt).toContainText(fmtNumber(3_567_000));
        await expect(stmt).toContainText(fmtNumber(425_245));

        await expect(stmt).toContainText(t("payslip.item.basePay"));
        await expect(stmt).toContainText(fmtNumber(3_100_000));
        await expect(stmt).toContainText(t("payslip.item.overtimePay"));
        await expect(stmt).toContainText(t("payslip.item.overtimeHours", { hours: "12" }));
        await expect(stmt).toContainText(fmtNumber(267_000));
        await expect(stmt).toContainText(t("payslip.item.mealAllowance"));
        await expect(stmt).toContainText(t("payslip.item.taxExempt"));
        await expect(stmt).toContainText(fmtNumber(200_000));

        for (const code of [
          "NATIONAL_PENSION",
          "HEALTH_INSURANCE",
          "LONG_TERM_CARE",
          "EMPLOYMENT_INSURANCE",
          "INCOME_TAX",
          "LOCAL_INCOME_TAX",
        ] as const) {
          await expect(stmt).toContainText(t(`payslip.deduction.${code}`));
        }
        await expect(stmt).toContainText(t("payslip.context.days", { days: "22" }));
        await expect(stmt).toContainText(t("payslip.context.workBreakdown", { worked: "18", holiday: "4" }));
        await expect(stmt).toContainText(t("payslip.context.days", { days: "0" }));

        await expect(stmt.getByRole("button", { name: t("payslip.action.savePdf"), exact: true })).toBeVisible();
        await expect(stmt.getByRole("button", { name: t("payslip.action.past"), exact: true })).toBeVisible();

        if (width === 390) {
          const topBar = page.getByRole("banner");
          await expect(topBar).toContainText(t("shell.title.payslip"));
          await expect(topBar).toContainText(`${hero.employee_name} · ${hero.employee_number}`);
          await expect(topBar.locator("button")).toHaveCount(0);

          const bottomNav = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
          await expect(bottomNav).toBeVisible();
          const tabs = bottomNav.locator("a");
          await expect(tabs).toHaveCount(5);
          await expect(tabs.nth(0)).toContainText(t("shell.link.home"));
          await expect(tabs.nth(1)).toContainText(t("shell.link.leave"));
          await expect(tabs.nth(2)).toContainText(t("shell.link.payroll"));
          await expect(tabs.nth(2)).toHaveAttribute("aria-current", "page");
          await expect(tabs.nth(3)).toContainText(t("shell.link.certificates"));
          await expect(tabs.nth(4)).toContainText(t("shell.link.profile"));

          const navBox = await bottomNav.boundingBox();
          expect(navBox).not.toBeNull();
          expect(Math.round(navBox!.y + navBox!.height)).toBeGreaterThanOrEqual(843);
        } else {
          const statusBar = page.getByRole("contentinfo", { name: t("shell.status.label"), exact: true });
          await expect(statusBar).toBeVisible();
          const statusBox = await statusBar.boundingBox();
          expect(statusBox).not.toBeNull();
          expect(Math.round(statusBox!.y + statusBox!.height)).toBeGreaterThanOrEqual(899);
        }

        await page.evaluate(() => document.fonts.ready);
        await withFullPage(page, () => shot(page, `payslip--${width}-${theme}`));
        await fits(page, `Console Payslip ${width} ${theme}`);
        await expectAxe(page, `Console Payslip ${width} ${theme}`);
        expect(fixture.unexpected).toEqual([]);
      } finally {
        fixture.release();
      }
    });
  }
}

test("Console /payslips contains overflow at 320x844 and keeps footer buttons single-line", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const { fixture } = await setupPayslipMock(page, { experience: "console", theme: "light" });
  try {
    await page.goto("/payslips");
    const stmt = page.locator('[data-pattern="phone-statement"]');
    await expect(stmt).toBeVisible();
    await expect(stmt).toContainText(fmtNumber(3_141_755));
    await fits(page, "Console Payslip 320 light");
    const wrappedButtons = await stmt.locator("button").evaluateAll(buttons =>
      buttons
        .filter(btn => {
          const style = getComputedStyle(btn);
          const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
          return btn.getBoundingClientRect().height > line * 2.5;
        })
        .map(btn => btn.textContent?.trim()),
    );
    expect(wrappedButtons).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /payslips supports period stepping, boundary disable, past payslips dialog, and PDF print trigger", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.print = () => {
      const target = window.parent as Window & { __payslipPrintText?: string };
      target.__payslipPrintText = document.body?.textContent ?? "";
    };
  });
  const { fixture } = await setupPayslipMock(page, { experience: "console", theme: "light" });
  const sepRow = saeonPayrollRow(saeonUniverse.hero.employeeNumber, saeonUniverse.hero.gradeCode, 6, true);
  const augRow = saeonPayrollRow(saeonUniverse.hero.employeeNumber, saeonUniverse.hero.gradeCode, 0, true);

  try {
    await page.goto("/payslips");
    const stmt = page.locator('[data-pattern="phone-statement"]');
    const prevBtn = stmt.getByRole("button", { name: t("attendanceRecords.toolbar.prevMonth"), exact: true });
    const nextBtn = stmt.getByRole("button", { name: t("attendanceRecords.toolbar.nextMonth"), exact: true });

    await expect(stmt).toContainText(fmtMonth("2026-10"));
    await expect(nextBtn).toBeDisabled();
    await expect(prevBtn).toBeEnabled();

    await prevBtn.click();
    await expect(stmt).toContainText(fmtMonth("2026-09"));
    await expect(stmt).toContainText(t("payslip.netAmount", { amount: fmtNumber(sepRow.netPay) }));
    await expect(nextBtn).toBeEnabled();
    await expect(prevBtn).toBeEnabled();

    await prevBtn.click();
    await expect(stmt).toContainText(fmtMonth("2026-08"));
    await expect(stmt).toContainText(t("payslip.netAmount", { amount: fmtNumber(augRow.netPay) }));
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    const pastTrigger = stmt.getByRole("button", { name: t("payslip.action.past"), exact: true });
    await pastTrigger.click();
    const dialog = page.getByRole("dialog", { name: t("payslip.past.title"), exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(fmtMonth("2026-10"));
    await expect(dialog).toContainText(fmtMonth("2026-09"));
    await expect(dialog).toContainText(fmtMonth("2026-08"));

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(pastTrigger).toBeFocused();

    await pastTrigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(fmtMonth("2026-10")) }).click();
    await expect(dialog).toBeHidden();
    await expect(pastTrigger).toBeFocused();
    await expect(stmt).toContainText(t("payslip.netAmount", { amount: fmtNumber(3_141_755) }));

    await stmt.getByRole("button", { name: t("payslip.action.savePdf"), exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { __payslipPrintText?: string }).__payslipPrintText ?? ""),
      )
      .toContain(fmtNumber(3_141_755));
    const printed = await page.evaluate(
      () => (window as Window & { __payslipPrintText?: string }).__payslipPrintText ?? "",
    );
    expect(printed).toContain(t("payslip.earnings"));
    expect(printed).toContain(t("payslip.deductions"));
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /payslips state sweep: loading, empty, monthEmpty, failed (503 + retry), refused (403), and detail 404/403", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  // 1. loading -> populated
  {
    const ctx = await setupPayslipMock(page, { listMode: "loading" });
    try {
      await page.goto("/payslips");
      await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
      ctx.releaseList();
      await expect(page.locator('[data-pattern="phone-statement"]')).toContainText(fmtNumber(3_141_755));
      expect(ctx.fixture.unexpected).toEqual([]);
    } finally {
      ctx.fixture.release();
    }
  }

  // 2. empty list
  {
    const ctx = await setupPayslipMock(page, { listMode: "empty" });
    try {
      await page.goto("/payslips");
      await expect(page.getByRole("heading", { name: t("payslip.empty.title"), exact: true })).toBeVisible();
      await fits(page, "Console Payslip 390 empty");
      await expectAxe(page, "Console Payslip 390 empty");
      expect(ctx.fixture.unexpected).toEqual([]);
    } finally {
      ctx.fixture.release();
    }
  }

  // 3. monthEmpty -> open latest payslip
  {
    const ctx = await setupPayslipMock(page);
    try {
      await page.goto("/payslips?month=2026-07");
      await expect(
        page.getByRole("heading", { name: t("payslip.monthEmpty.title", { month: fmtMonth("2026-07") }), exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: t("payslip.monthEmpty.latest"), exact: true }).click();
      await expect(page.locator('[data-pattern="phone-statement"]')).toContainText(fmtNumber(3_141_755));
      expect(ctx.fixture.unexpected).toEqual([]);
    } finally {
      ctx.fixture.release();
    }
  }

  // 4. list failed 503 + retry recovery
  {
    const ctx = await setupPayslipMock(page, { listMode: "failed" });
    let recover = false;
    await mockRoute(page, "get", "/api/v1/me/inbox-docs", () =>
      recover ? { status: 200, json: ctx.docs } : { status: 503, json: failure("service_unavailable") },
    );
    try {
      await page.goto("/payslips");
      await expect(page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
      recover = true;
      await page.getByRole("button", { name: t("common.retry"), exact: true }).click();
      await expect(page.locator('[data-pattern="phone-statement"]')).toContainText(fmtNumber(3_141_755));
      expect(ctx.fixture.unexpected).toEqual([]);
    } finally {
      ctx.fixture.release();
    }
  }

  // 5. list refused 403
  {
    const ctx = await setupPayslipMock(page, { listMode: "refused" });
    try {
      await page.goto("/payslips");
      await expect(page.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toBeVisible();
      expect(ctx.fixture.unexpected).toEqual([]);
    } finally {
      ctx.fixture.release();
    }
  }

  // 6. detail 404 & 403 keep period/past-payslips controls mounted
  {
    const ctx404 = await setupPayslipMock(page, { detailMode: "not_found" });
    try {
      await page.goto("/payslips");
      await expect(page.getByRole("heading", { name: t("common.read.notFound.title"), exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: t("payslip.action.past"), exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: t("payslip.action.savePdf"), exact: true })).toBeDisabled();
      expect(ctx404.fixture.unexpected).toEqual([]);
    } finally {
      ctx404.fixture.release();
    }

    const ctx403 = await setupPayslipMock(page, { detailMode: "refused" });
    try {
      await page.goto("/payslips");
      await expect(page.getByRole("heading", { name: t("common.denied.panel"), exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: t("payslip.action.past"), exact: true })).toBeEnabled();
      expect(ctx403.fixture.unexpected).toEqual([]);
    } finally {
      ctx403.fixture.release();
    }
  }
});

test("Baseline /payslips renders Classic layout without Console shell chrome", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { fixture } = await setupPayslipMock(page, { experience: "baseline", theme: "light" });
  try {
    await page.goto("/payslips");
    await expect(page.locator("[data-console-shell]")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: t("payslip.title"), exact: true })).toBeVisible();
    await expect(page.locator("main")).toContainText(fmtNumber(3_141_755));
    await fits(page, "Baseline Payslip 390 light");
    await expectAxe(page, "Baseline Payslip 390 light");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Console /payslips preserves active period pay_date, disables PDF export, and prevents cross-period net pay leakage on pending and 503 failure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ctx = await setupPayslipMock(page, { experience: "console", theme: "light", faultClock: true });
  const sepId = "00000000-0000-4000-8950-000000002009";
  const sepRow = saeonPayrollRow(saeonUniverse.hero.employeeNumber, saeonUniverse.hero.gradeCode, 6, true);
  let releaseSep!: () => void;
  let holdFirstSep = true;
  const heldSep = new Promise<void>(resolve => {
    releaseSep = resolve;
  });
  let sepMode: "failed" | "populated" = "failed";

  await mockRoute(page, "get", "/api/v1/me/inbox-docs/{id}", async request => {
    const id = new URL(request.url()).pathname.split("/").at(-1);
    if (id === sepId) {
      if (holdFirstSep) {
        holdFirstSep = false;
        await heldSep;
      }
      if (sepMode === "failed") return { status: 503, json: failure("service_unavailable") };
    }
    const detail = saeonHeroPayslipDetail(id);
    return detail ? { status: 200, json: detail } : { status: 404, json: failure("not_found") };
  });

  try {
    await page.goto("/payslips");
    const stmt = page.locator('[data-pattern="phone-statement"]');
    const savePdf = stmt.getByRole("button", { name: t("payslip.action.savePdf"), exact: true });
    const prevBtn = stmt.getByRole("button", { name: t("attendanceRecords.toolbar.prevMonth"), exact: true });

    await expect(stmt).toContainText(fmtMonth("2026-10"));
    await expect(stmt).toContainText(`${t("payslip.payDateLabel")} 11-25`);
    await expect(stmt).toContainText(fmtNumber(3_141_755));
    await expect(savePdf).toBeEnabled();

    await prevBtn.click();

    await expect(stmt).toContainText(fmtMonth("2026-09"));
    await expect(stmt).toContainText(`${t("payslip.payDateLabel")} 10-23`);
    await expect(stmt).not.toContainText("11-25");
    await expect(stmt).not.toContainText(fmtNumber(3_141_755));
    await expect(savePdf).toBeDisabled();

    releaseSep();
    await expect(stmt.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
    await expect(stmt.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
    await expect(stmt).toContainText(`${t("payslip.payDateLabel")} 10-23`);
    await expect(stmt).not.toContainText("11-25");
    await expect(stmt).not.toContainText(fmtNumber(3_141_755));
    await expect(savePdf).toBeDisabled();

    sepMode = "populated";
    await stmt.getByRole("button", { name: t("common.retry"), exact: true }).click();
    await expect(stmt).toContainText(fmtNumber(sepRow.netPay));
    await expect(savePdf).toBeEnabled();
    expect(ctx.fixture.unexpected).toEqual([]);
  } finally {
    releaseSep?.();
    ctx.fixture.release();
  }
});

test("Baseline /payslips handles detail 403 refusal and 503 failure with retry cleanly", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  {
    const ctx403 = await setupPayslipMock(page, { experience: "baseline", detailMode: "refused" });
    try {
      await page.goto("/payslips");
      const main = page.locator("main");
      await expect(main.getByRole("heading", { name: t("common.denied.panel"), exact: true })).toBeVisible();
      await expect(main).not.toContainText(t("payslip.detail.unavailable"));
      await expect(main.getByRole("button", { name: t("payslip.action.savePdf"), exact: true })).toBeDisabled();
      await expect(main.getByRole("button", { name: t("payslip.action.past"), exact: true })).toBeEnabled();
      await fits(page, "Baseline Payslip 390 403");
      await expectAxe(page, "Baseline Payslip 390 403");
      expect(ctx403.fixture.unexpected).toEqual([]);
    } finally {
      ctx403.fixture.release();
    }
  }

  {
    const ctx503 = await setupPayslipMock(page, { experience: "baseline", detailMode: "failed" });
    let recover = false;
    await mockRoute(page, "get", "/api/v1/me/inbox-docs/{id}", request => {
      if (!recover) return { status: 503, json: failure("service_unavailable") };
      const id = new URL(request.url()).pathname.split("/").at(-1);
      const detail = saeonHeroPayslipDetail(id);
      return detail ? { status: 200, json: detail } : { status: 404, json: failure("not_found") };
    });
    try {
      await page.goto("/payslips");
      const main = page.locator("main");
      await expect(main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
      await expect(main).not.toContainText(t("payslip.detail.unavailable"));
      await expect(main.getByRole("button", { name: t("payslip.action.savePdf"), exact: true })).toBeDisabled();
      await fits(page, "Baseline Payslip 390 503");
      await expectAxe(page, "Baseline Payslip 390 503");
      recover = true;
      await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
      await expect(main).toContainText(fmtNumber(3_141_755));
      await expect(main.getByRole("button", { name: t("payslip.action.savePdf"), exact: true })).toBeEnabled();
      expect(ctx503.fixture.unexpected).toEqual([]);
    } finally {
      ctx503.fixture.release();
    }
  }
});
