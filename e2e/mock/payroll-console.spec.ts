// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { expectAxe, fits } from "../a11y";
import { test } from "../locale-fixture";
import { payrollScreens } from "../states/payroll";
import { failure, modules, screenAccess } from "./fixtures";
import { mockRoute } from "./route";
import {
  SAEON_HERO_ID,
  saeonAdminToken,
  saeonAdminUser,
  saeonPayGroups,
  saeonPayrollRates,
  saeonPayrollRunDetail,
  saeonUniverse,
} from "./saeon";
import { captureBuiltConsoleShot, enableConsole } from "./saeon-mod5-6";
import { saeonHeroPayslipDraft, saeonPayrollRunsPage, saeonRunPreview } from "./saeon-mod7-8";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

function combinedPayrollAccess(path = "/payroll") {
  const base = screenAccess(path);
  const setup = screenAccess("/payroll/setup");
  const create = screenAccess("/payroll/runs/new");
  const ref = screenAccess("/payroll/reference");
  const emp = screenAccess(`/payroll/employees/${SAEON_HERO_ID}`);
  const nav = ["/org", "/people", "/approvals", "/attendance", "/statutory"].flatMap((p) => screenAccess(p).entries);
  return {
    ...base,
    decisions: { ...base.decisions, ...setup.decisions, ...create.decisions, ...ref.decisions, ...emp.decisions },
    entries: [...base.entries, ...setup.entries, ...create.entries, ...ref.entries, ...emp.entries, ...nav],
  };
}

async function setupSaeonPayroll(
  page: Page,
  opts?: { baseline?: boolean; theme?: "light" | "dark"; totalRuns?: number; createConflict?: boolean; refuse?: boolean; failState?: { fail: boolean } },
) {
  if (!opts?.baseline) await enableConsole(page, opts?.theme ?? "light");
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  const groups = saeonPayGroups();

  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: saeonAdminToken() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: saeonAdminUser() });
  await mockRoute(page, "get", "/api/v1/onboarding/modules", {
    status: 200,
    json: [...modules.ready, { key: "payroll", ready: true, unblock: null }],
  });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: combinedPayrollAccess() });

  await mockRoute(page, "get", "/api/v1/payroll/pay-groups", () => {
    if (opts?.refuse) return { status: 403, json: failure("forbidden") };
    if (opts?.failState?.fail) {
      return { status: 503, json: failure("service_unavailable") };
    }
    return { status: 200, json: groups };
  });

  const runQueries: URLSearchParams[] = [];
  await mockRoute(page, "get", "/api/v1/payroll/runs", (req) => {
    const query = new URL(req.url()).searchParams;
    runQueries.push(query);
    return {
      status: 200,
      json: saeonPayrollRunsPage({
        payGroupId: query.get("pay_group_id"),
        legalEntityId: query.get("legal_entity_id"),
        offset: Number(query.get("offset") ?? 0),
        limit: Number(query.get("limit") ?? 50),
        totalCount: opts?.totalRuns ?? 12,
      }),
    };
  });

  await mockRoute(page, "get", "/api/v1/payroll/runs/preview", (req) => {
    const gid = new URL(req.url()).searchParams.get("pay_group_id") ?? groups.items[0]!.id;
    return { status: 200, json: saeonRunPreview(gid) };
  });

  await mockRoute(page, "post", "/api/v1/payroll/runs", () => {
    if (opts?.createConflict) return { status: 409, json: failure("regular_run_exists") };
    return {
      status: 201,
      json: saeonPayrollRunsPage({ totalCount: 1 }).items[0]!,
    };
  });

  await mockRoute(page, "get", "/api/v1/payroll/reference/rates", (req) => {
    const entityId = new URL(req.url()).searchParams.get("legal_entity_id");
    if (entityId === groups.legal_entities[2]?.id) {
      return { status: 200, json: { country_code: "US", adopted: false, items: [] } };
    }
    const base = saeonPayrollRates();
    if (entityId === groups.legal_entities[1]?.id) {
      return {
        status: 200,
        json: {
          ...base,
          items: base.items.map((item, idx) => (idx === 0 ? { ...item, status: "HELD" as const, instrument_ko: "" } : item)),
        },
      };
    }
    return { status: 200, json: base };
  });

  await mockRoute(page, "get", "/api/v1/payroll/employees/{employeeId}/payslip-draft", () => ({
    status: 200,
    json: saeonHeroPayslipDraft(SAEON_HERO_ID),
  }));

  return { fixture, groups, runQueries };
}

for (const width of [1440, 390] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`Console Module 7 screens render P2/P8/P3 patterns cleanly at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const { fixture } = await setupSaeonPayroll(page, { theme });
      try {
        await page.goto("/payroll");
        await expect(page.locator('[data-pattern="list-record"]')).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: t("payroll.title"), exact: true })).toBeVisible();
        await fits(page, `payroll-home ${width} ${theme}`);
        await expectAxe(page, `payroll-home ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "payroll-home", theme);

        await page.goto("/payroll/setup");
        await expect(page.locator('[data-pattern="wizard"]')).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: t("payroll.setup.page"), exact: true })).toBeVisible();
        await fits(page, `payroll-setup ${width} ${theme}`);
        await expectAxe(page, `payroll-setup ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "payroll-setup", theme);

        await page.goto("/payroll/runs/new");
        await expect(page.locator('[data-pattern="wizard"]')).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: t("payroll.create.title"), exact: true })).toBeVisible();
        await fits(page, `payroll-run-new ${width} ${theme}`);
        await expectAxe(page, `payroll-run-new ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "payroll-run-new", theme);

        await page.goto("/payroll/reference");
        await expect(page.locator('[data-pattern="list-record"]')).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: t("payroll.reference.title"), exact: true })).toBeVisible();
        await expect(page.getByRole("grid", { name: t("payroll.reference.title"), exact: true })).toBeVisible();
        await fits(page, `payroll-reference ${width} ${theme}`);
        await expectAxe(page, `payroll-reference ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "payroll-reference", theme);

        await page.goto(`/payroll/employees/${SAEON_HERO_ID}?period=2026-10&pay_date=2026-11-25`);
        await expect(page.locator('[data-pattern="record"]')).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: t("payroll.employee.title"), exact: true })).toBeVisible();
        await fits(page, `payroll-employee ${width} ${theme}`);
        await expectAxe(page, `payroll-employee ${width} ${theme}`);
        await captureBuiltConsoleShot(page, width, "payroll-employee", theme);
        if (width === 390 && theme === "light") {
          await page.setViewportSize({ width: 320, height: 900 });
          await fits(page, "payroll-employee 320 light");
          await page.setViewportSize({ width, height: 900 });
        }

        expect(fixture.unexpected).toEqual([]);
      } finally {
        await page.close();
        fixture.release();
      }
    });
  }
}

test("Console /payroll supports server pay_group_id filtering and >100 runs pagination", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, groups, runQueries } = await setupSaeonPayroll(page, { totalRuns: 625 });
  try {
    await page.goto("/payroll");
    const grid = page.getByRole("grid", { name: t("payroll.runs", { name: groups.items[0]!.name }), exact: true });
    await expect(grid).toBeVisible();
    expect(runQueries.some((q) => q.get("pay_group_id") === groups.items[0]!.id)).toBe(true);
    await expect(page.getByText(t("statutory.count", { count: 125 }), { exact: true })).toBeVisible();

    const loadMore = page.getByRole("button", { name: t("common.more"), exact: true });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(grid.locator('[role="row"][data-row-id]')).not.toHaveCount(0);
    await loadMore.click();
    await expect(loadMore).toHaveCount(0);

    await page.getByRole("button", { name: new RegExp(groups.items[1]!.name) }).click();
    expect(runQueries.some((q) => q.get("pay_group_id") === groups.items[1]!.id)).toBe(true);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

test("Console /payroll/setup enforces zero preselection and /payroll/runs/new surfaces 409 refusal", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, groups } = await setupSaeonPayroll(page, { createConflict: true });
  try {
    await page.goto("/payroll/setup");
    await page.getByRole("button", { name: commitLabel({ kind: "payGroup", mode: "save" }), exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(t("payroll.setup.required"));

    await page.goto("/payroll/runs/new");
    await expect(page.getByText(t("payroll.create.kind.REGULAR"), { exact: true })).toBeVisible();
    await expect(page.getByText(t("payroll.create.kind.OFF_CYCLE"))).toHaveCount(0);
    await page.getByText(new RegExp(groups.items[0]!.name)).click();
    await page.getByText(t("payroll.create.kind.REGULAR"), { exact: true }).click();
    await expect(page.getByRole("main").getByText("2026-11", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: t("payroll.create.submit"), exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(t("payroll.create.refuse.regular_run_exists"));

    await page.goto(`/payroll/reference?entity=${groups.legal_entities[1]!.id}`);
    await expect(page.getByText(t("payroll.reference.held")).first()).toBeVisible();
    await page.goto(`/payroll/reference?entity=${groups.legal_entities[2]!.id}`);
    await expect(page.getByText(t("payroll.reference.noPack"), { exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});

for (const baseline of [false, true]) {
  test(`payroll creation checks the refreshed preview month before retry${baseline ? " @baseline" : ""}`, async ({ page }) => {
    const { fixture, groups } = await setupSaeonPayroll(page, { baseline });
    const initial = saeonRunPreview(groups.items[0]!.id);
    const next = { ...initial, attribution_month: "2026-12", pay_date: "2026-12-25",
      period_start: "2026-12-01", period_end: "2026-12-31", variable_period_start: "2026-11-16", variable_period_end: "2026-12-15" };
    const detail = saeonPayrollRunDetail();
    const created = { ...detail.run, ...next };
    const submitted: unknown[] = [];
    const refresh = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/payroll/runs/{id}", { status: 200, json: { ...detail, run: created } });
    await mockRoute(page, "get", "/api/v1/payroll/runs/preview", async () => {
      if (!submitted.length) return { status: 200, json: initial };
      await refresh.promise;
      return { status: 200, json: next };
    });
    await mockRoute(page, "post", "/api/v1/payroll/runs", request => {
      submitted.push(request.postDataJSON());
      if (submitted.length === 1) return { status: 409, json: failure("payroll_preview_changed") };
      return { status: 201, json: created };
    });

    try {
      await page.goto("/payroll/runs/new");
      await page.getByText(new RegExp(groups.items[0]!.name)).click();
      await page.getByText(t("payroll.create.kind.REGULAR"), { exact: true }).click();
      const main = page.getByRole("main");
      const submit = page.getByRole("button", { name: t("payroll.create.submit"), exact: true });
      await expect(main.getByText(initial.attribution_month, { exact: true }).first()).toBeVisible();
      await submit.click();
      await expect(page.getByRole("alert")).toContainText(t("payroll.create.refuse.payroll_preview_changed"));
      const fields = { pay_group_id: initial.pay_group_id, kind: initial.kind };
      expect(submitted).toEqual([{ ...fields, expected_attribution_month: initial.attribution_month }]);
      await expect(submit).toBeDisabled();
      refresh.resolve();
      await expect(main.getByText(next.attribution_month, { exact: true }).first()).toBeVisible();
      await submit.click();
      await expect(page).toHaveURL(new RegExp(`/payroll/runs/${created.id}$`));
      expect(submitted).toEqual([
        { ...fields, expected_attribution_month: initial.attribution_month },
        { ...fields, expected_attribution_month: next.attribution_month },
      ]);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      refresh.resolve();
      await page.close();
      fixture.release();
    }
  });
}

test("Console /payroll distinguishes 403 refusal from 503 retry recovery", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const refused = await setupSaeonPayroll(page, { refuse: true });
  try {
    await page.goto("/payroll");
    await expect(page.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
    await expect(page.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(0);
    expect(refused.fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    refused.fixture.release();
  }

  const page2 = await page.context().newPage();
  await page2.setViewportSize({ width: 1440, height: 900 });
  const failState = { fail: true };
  const failed = await setupSaeonPayroll(page2, { failState });
  try {
    await page2.goto("/payroll");
    const retry = page2.getByRole("button", { name: t("common.retry"), exact: true });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    failState.fail = false;
    await retry.click();
    await expect(page2.getByText(saeonUniverse.entities[0]!.name, { exact: true })).toBeVisible();
    expect(failed.fixture.unexpected).toEqual([]);
  } finally {
    await page2.close();
    failed.fixture.release();
  }
});
