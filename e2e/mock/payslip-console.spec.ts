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
const shellBottomBar = (page: Page, width: number) => width === 390
  ? page.getByRole("navigation", { name: t("shell.nav"), exact: true })
  : page.getByRole("contentinfo", { name: t("shell.status.label"), exact: true });

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

        const bottomBar = shellBottomBar(page, width);
        await expect(bottomBar).toBeInViewport({ ratio: 1 });
        const barBox = await bottomBar.boundingBox();
        expect(barBox).not.toBeNull();
        expect(Math.abs(barBox!.y + barBox!.height - height)).toBeLessThanOrEqual(1);

        if (width === 390) {
          const topBar = page.getByRole("banner");
          await expect(topBar).toContainText(t("shell.title.payslip"));
          await expect(topBar).toContainText(`${hero.employee_name} · ${hero.employee_number}`);
          await expect(topBar.locator("button")).toHaveCount(0);

          const tabs = bottomBar.locator("a");
          await expect(tabs).toHaveCount(5);
          await expect(tabs.nth(0)).toContainText(t("shell.link.home"));
          await expect(tabs.nth(1)).toContainText(t("shell.link.leave"));
          await expect(tabs.nth(2)).toContainText(t("shell.link.payroll"));
          await expect(tabs.nth(2)).toHaveAttribute("aria-current", "page");
          await expect(tabs.nth(3)).toContainText(t("shell.link.certificates"));
          await expect(tabs.nth(4)).toContainText(t("shell.link.profile"));
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

for (const width of [390, 1440] as const) {
  test(`Console /payslips preserves active period pay_date, disables PDF export, and keeps compact hero & visible actions on pending and 503 failure at ${width}px`, async ({
    page,
  }) => {
    const height = width === 1440 ? 900 : 844;
    await page.setViewportSize({ width, height });
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
      const hero = stmt.locator('[class*="hero"]').first();
      const savePdf = stmt.getByRole("button", { name: t("payslip.action.savePdf"), exact: true });
      const pastBtn = stmt.getByRole("button", { name: t("payslip.action.past"), exact: true });
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

      // Wait >200ms so Skeleton's 200ms fade-in completes and verify compact hero + visible action buttons.
      const skeleton = hero.locator('[role="status"]');
      await expect(skeleton).toBeVisible();
      await expect(hero.locator('[data-bone="short"]')).toBeVisible();
      await expect(hero.locator('[data-bone="title"]')).toBeVisible();
      await expect(stmt.locator('[data-read-layout="record"]')).toHaveCount(0);

      const bottomBoundary = await shellBottomBar(page, width).boundingBox();
      expect(bottomBoundary).not.toBeNull();

      const loadingHeroBox = await hero.boundingBox();
      const loadingSaveBox = await savePdf.boundingBox();
      const loadingPastBox = await pastBtn.boundingBox();
      expect(loadingHeroBox).not.toBeNull();
      expect(loadingSaveBox).not.toBeNull();
      expect(loadingPastBox).not.toBeNull();
      expect(loadingHeroBox!.height).toBeLessThan(160);
      expect(loadingSaveBox!.y).toBeGreaterThanOrEqual(0);
      expect(loadingPastBox!.y).toBeGreaterThanOrEqual(0);
      expect(loadingSaveBox!.y + loadingSaveBox!.height).toBeLessThanOrEqual(bottomBoundary!.y);
      expect(loadingPastBox!.y + loadingPastBox!.height).toBeLessThanOrEqual(bottomBoundary!.y);
      if (width === 1440) {
        expect(loadingSaveBox!.y - (loadingHeroBox!.y + loadingHeroBox!.height)).toBeLessThan(48);
      }

      releaseSep();
      await expect(stmt.getByRole("heading", { name: t("common.loadFailed.title"), exact: true })).toBeVisible();
      await expect(stmt.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
      await expect(stmt.locator('[data-read-layout="record"]')).toHaveCount(0);
      await expect(stmt).toContainText(`${t("payslip.payDateLabel")} 10-23`);
      await expect(stmt).not.toContainText("11-25");
      await expect(stmt).not.toContainText(fmtNumber(3_141_755));
      await expect(savePdf).toBeDisabled();

      const failedHeroBox = await hero.boundingBox();
      const failedSaveBox = await savePdf.boundingBox();
      const failedPastBox = await pastBtn.boundingBox();
      expect(failedHeroBox).not.toBeNull();
      expect(failedSaveBox).not.toBeNull();
      expect(failedPastBox).not.toBeNull();
      expect(failedHeroBox!.height).toBeLessThan(width === 1440 ? 240 : 340);
      expect(failedSaveBox!.y + failedSaveBox!.height).toBeLessThanOrEqual(bottomBoundary!.y);
      expect(failedPastBox!.y + failedPastBox!.height).toBeLessThanOrEqual(bottomBoundary!.y);
      if (width === 1440) {
        expect(failedSaveBox!.y - (failedHeroBox!.y + failedHeroBox!.height)).toBeLessThan(48);
      }

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
}

for (const width of [390, 1440] as const) {
  test(`Baseline /payslips handles detail 403 refusal and 503 failure inside card with visible actions at ${width}px`, async ({
    page,
  }) => {
    const height = width === 1440 ? 900 : 844;
    await page.setViewportSize({ width, height });

    {
      const ctx403 = await setupPayslipMock(page, { experience: "baseline", detailMode: "refused" });
      try {
        await page.goto("/payslips");
        const main = page.locator("main");
        const deniedHeading = main.getByRole("heading", { name: t("common.denied.panel"), exact: true });
        await expect(deniedHeading).toBeVisible();
        const deniedCard = main
          .locator('[class*="card"]')
          .filter({ has: page.getByRole("heading", { name: t("common.denied.panel"), exact: true }) });
        await expect(deniedCard).toBeVisible();
        expect(
          await deniedCard.evaluate(el => {
            const cs = getComputedStyle(el);
            return cs.borderTopStyle === "solid" && cs.backgroundColor !== "rgba(0, 0, 0, 0)";
          }),
        ).toBe(true);
        await expect(main.locator('[data-read-layout="record"]')).toHaveCount(0);
        await expect(main).not.toContainText(t("payslip.detail.unavailable"));

        const saveBtn = main.getByRole("button", { name: t("payslip.action.savePdf"), exact: true });
        const pastBtn = main.getByRole("button", { name: t("payslip.action.past"), exact: true });
        await expect(saveBtn).toBeDisabled();
        await expect(pastBtn).toBeEnabled();

        const deniedCardBox = await deniedCard.boundingBox();
        const saveBox = await saveBtn.boundingBox();
        const pastBox = await pastBtn.boundingBox();
        expect(deniedCardBox).not.toBeNull();
        expect(saveBox).not.toBeNull();
        expect(pastBox).not.toBeNull();
        expect(deniedCardBox!.height).toBeLessThan(320);
        expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(height);
        expect(pastBox!.y + pastBox!.height).toBeLessThanOrEqual(height);

        await fits(page, `Baseline Payslip ${width} 403`);
        await expectAxe(page, `Baseline Payslip ${width} 403`);
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
        const failedHeading = main.getByRole("heading", { name: t("common.loadFailed.title"), exact: true });
        await expect(failedHeading).toBeVisible();
        const failedCard = main
          .locator('[class*="card"]')
          .filter({ has: page.getByRole("heading", { name: t("common.loadFailed.title"), exact: true }) });
        await expect(failedCard).toBeVisible();
        expect(
          await failedCard.evaluate(el => {
            const cs = getComputedStyle(el);
            return cs.borderTopStyle === "solid" && cs.backgroundColor !== "rgba(0, 0, 0, 0)";
          }),
        ).toBe(true);
        await expect(main.locator('[data-read-layout="record"]')).toHaveCount(0);
        await expect(main).not.toContainText(t("payslip.detail.unavailable"));

        const saveBtn = main.getByRole("button", { name: t("payslip.action.savePdf"), exact: true });
        const pastBtn = main.getByRole("button", { name: t("payslip.action.past"), exact: true });
        await expect(saveBtn).toBeDisabled();
        await expect(pastBtn).toBeEnabled();

        const failedCardBox = await failedCard.boundingBox();
        const saveBox = await saveBtn.boundingBox();
        const pastBox = await pastBtn.boundingBox();
        expect(failedCardBox).not.toBeNull();
        expect(saveBox).not.toBeNull();
        expect(pastBox).not.toBeNull();
        expect(failedCardBox!.height).toBeLessThan(320);
        expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(height);
        expect(pastBox!.y + pastBox!.height).toBeLessThanOrEqual(height);
        expect(saveBox!.y - (failedCardBox!.y + failedCardBox!.height)).toBeLessThan(60);

        await fits(page, `Baseline Payslip ${width} 503`);
        await expectAxe(page, `Baseline Payslip ${width} 503`);
        recover = true;
        await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await expect(main).toContainText(fmtNumber(3_141_755));
        await expect(saveBtn).toBeEnabled();
        expect(ctx503.fixture.unexpected).toEqual([]);
      } finally {
        ctx503.fixture.release();
      }
    }
  });
}

for (const experience of ["console", "baseline"] as const) {
  test(`${experience === "console" ? "Console" : "Baseline"} /payslips preserves cached statement, ledgers, and enabled PDF save when SSE refetch fails with 503 (stale)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const ctx = await setupPayslipMock(page, { experience, theme: "light", faultClock: true });

    await page.addInitScript(() => {
      const prevFetch = window.fetch;
      let pushFrame: ((chunk: string) => void) | null = null;
      (window as Window & { __emitPayslipSse?: (frame: string) => void }).__emitPayslipSse = frame => {
        pushFrame?.(frame);
      };
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname !== "/api/v1/events") return prevFetch(input, init);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                const enc = new TextEncoder();
                pushFrame = chunk => controller.enqueue(enc.encode(chunk));
                pushFrame(": heartbeat\n\n");
                request.signal.addEventListener(
                  "abort",
                  () => {
                    pushFrame = null;
                    controller.close();
                  },
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      };
    });

    let failDetailRefetch = false;
    await mockRoute(page, "get", "/api/v1/me/inbox-docs/{id}", request => {
      if (failDetailRefetch) return { status: 503, json: failure("service_unavailable") };
      const id = new URL(request.url()).pathname.split("/").at(-1);
      const detail = saeonHeroPayslipDetail(id);
      return detail ? { status: 200, json: detail } : { status: 404, json: failure("not_found") };
    });

    try {
      await page.goto("/payslips");
      const container = experience === "console" ? page.locator('[data-pattern="phone-statement"]') : page.locator("main");
      const saveBtn = container.getByRole("button", { name: t("payslip.action.savePdf"), exact: true });

      await expect(container).toContainText(fmtNumber(3_141_755));
      await expect(container).toContainText(t("payslip.item.basePay"));
      await expect(container).toContainText(fmtNumber(3_100_000));
      await expect(container).toContainText(t("payslip.deduction.NATIONAL_PENSION"));
      await expect(saveBtn).toBeEnabled();

      // Trigger background detail refetch via SSE change frame and fail with 503.
      failDetailRefetch = true;
      await page.evaluate(() => {
        const emit = (window as Window & { __emitPayslipSse?: (frame: string) => void }).__emitPayslipSse;
        emit?.('event: change\ndata: {"type":"tenant","id":null,"at":"2026-11-22T00:00:00Z"}\n\n');
      });

      await expect(container).toContainText(t("common.read.stale"));
      await expect(container).toContainText(fmtNumber(3_141_755));
      await expect(container).toContainText(t("payslip.item.basePay"));
      await expect(container).toContainText(fmtNumber(3_100_000));
      await expect(container).toContainText(t("payslip.deduction.NATIONAL_PENSION"));
      await expect(container).toContainText(fmtNumber(425_245));
      await expect(container).not.toContainText(t("payslip.detail.unavailable"));
      await expect(saveBtn).toBeEnabled();

      if (experience === "baseline") {
        const cardCount = await container.locator('[class*="card"]').count();
        expect(cardCount).toBeGreaterThanOrEqual(4);
        expect(cardCount).toBeLessThanOrEqual(5);
      }

      expect(ctx.fixture.unexpected).toEqual([]);
    } finally {
      ctx.fixture.release();
    }
  });
}
