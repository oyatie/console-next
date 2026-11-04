// SPDX-License-Identifier: LicenseRef-Proprietary
import { test, expect, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { payGroups } from "../mock/payroll";
import { AT, failure, id, screenAccess } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { payrollRunCreateScreen, payrollScreens } from "./payroll";
import { expectAxe, fits } from "../a11y";
import type { PayrollRunDetail } from "@console/api/pending";

test.beforeAll(() => loadCatalog("ko"));
const run = { id: id(880), legal_entity_id: payGroups.items[2]!.legal_entity_id, pay_group_id: payGroups.items[2]!.id, kind: "REGULAR" as const, attribution_month: "2026-10", pay_date: "2026-10-25", source_label: "모의 급여 상세", period_start: "2026-10-01", period_end: "2026-10-31", variable_period_start: "2026-09-16", variable_period_end: "2026-10-15", status: "STAGED" as const, calculation_enabled: false, created_at: AT, updated_at: AT };
const detail: PayrollRunDetail = { run, legal_basis: {}, source_summary: {}, lines: [], lines_total: 0, lines_limit: 50, lines_offset: 0, exceptions_open: 0, exceptions_total: 0, calculation: null, disbursement: null, payslip_delivery: null };
const preview = { legal_entity_id: payGroups.items[0]!.legal_entity_id, pay_group_id: payGroups.items[0]!.id, kind: "REGULAR" as const, attribution_month: "2026-11", pay_date: "2026-11-25", pay_date_clamped: false, period_start: "2026-11-01", period_end: "2026-11-30", variable_period_start: "2026-10-16", variable_period_end: "2026-11-15" };
const created = { ...run, ...preview, id: id(881), source_label: "모의 급여 그룹 1 · 2026-11 · REGULAR", status: "BLOCKED_LEGAL_GATE" as const };

async function chooseRegular(page: Page) {
  await page.getByRole("radio", { name: payGroups.items[0]!.name, exact: true }).locator("xpath=ancestor::label[1]").click();
  await page.getByRole("radio", { name: t("payroll.create.kind.REGULAR"), exact: true }).locator("xpath=ancestor::label[1]").click();
  await expect(page.getByRole("main")).toContainText(preview.attribution_month);
  await expect(page.getByRole("main")).toContainText(fmtDate(preview.pay_date));
}

for (const [width, colorScheme] of [[1440, "light"], [390, "dark"]] as const) test(`home run links open their read-only stages at ${width}px ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/payroll/") && request.method() !== "GET") writes.push(request.url());
  });
  await page.route("**/api/v1/access/me", route => route.fulfill({ json: screenAccess("/payroll/setup") }));
  await page.route("**/api/v1/payroll/runs", route => route.fulfill({ json: { items: [run], total: 1, limit: 50, offset: 0 } }));
  await page.route(`**/api/v1/payroll/runs/${run.id}`, route => route.fulfill({ json: detail }));
  try {
    await page.goto("/payroll");
    const main = page.getByRole("main");
    const card = main.getByRole("region", { name: payGroups.items[2]!.name, exact: true });
    await expect(card.getByRole("link", { name: run.source_label, exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: run.source_label, exact: true })).toHaveCount(1);
    await fits(page, `payroll-home/${width}`);
    await expectAxe(page, `payroll-home/${width}`);
    await page.screenshot({ path: test.info().outputPath(`home-${width}.png`) });
    await card.getByRole("link", { name: run.source_label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/payroll/runs/${run.id}$`));
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(run.source_label);
    await expect(main).toContainText(payGroups.items[2]!.name);
    await expect(main).toContainText(payGroups.legal_entities[1]!.name!);
    const rail = main.getByRole("list", { name: t("payroll.stages.title") });
    await expect(rail.getByRole("listitem")).toHaveCount(6);
    for (const step of ["attendance", "calculate", "exceptions", "approval", "payment", "delivery"] as const)
      await expect(rail).toContainText(t(`payroll.stage.${step}`));
    await expect(rail.locator('[aria-current="step"]')).toHaveText(t("payroll.stage.attendance"));
    await expect(rail.getByRole("link").or(rail.getByRole("button"))).toHaveCount(0);
    await fits(page, `payroll-run/${width}`);
    await expectAxe(page, `payroll-run/${width}`);
    await page.screenshot({ path: test.info().outputPath(`run-${width}.png`) });
    await page.reload();
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(run.source_label);
    expect(writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const state of ["loading", "failed", "refused", "missing"] as const) test(`run: ${state} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/payroll/runs/${run.id}`, async route => {
    if (state === "loading") await held;
    if (page.isClosed()) return;
    return route.fulfill({ status: state === "failed" ? 500 : state === "refused" ? 403 : 404, json: failure(state === "failed" ? "internal_error" : state === "refused" ? "forbidden" : "not_found") });
  });
  try {
    await page.goto(`/payroll/runs/${run.id}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(t("payroll.runName"));
    if (state === "loading") await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
    else if (state === "refused") await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
    else if (state === "failed") await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible({ timeout: 15_000 });
    else await expect(main).toContainText(t("common.read.notFound.title"));
    await expect(main.getByRole("list", { name: t("payroll.stages.title") })).toHaveCount(0);
    await fits(page, `run/${state}`);
    await expectAxe(page, `run/${state}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); release(); fixture.release(); }
});

for (const state of ["empty", "populated"] as const) test(`home offers run creation after ${state} groups load with edit access`, async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], state);
  await page.route("**/api/v1/access/me", route => route.fulfill({ json: screenAccess("/payroll/setup") }));
  try {
    await page.goto("/payroll");
    const main = page.getByRole("main");
    await expect(main.getByRole("region", { name: state === "empty" ? t("payroll.setup.title") : payGroups.items[0]!.name, exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: t("payroll.create.title"), exact: true })).toHaveAttribute("href", "/payroll/runs/new");
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const [width, colorScheme] of [[1440, "light"], [390, "dark"]] as const) test(`run creation previews derived facts and submits at ${width}px ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const fixture = await mockScreen(page, payrollRunCreateScreen, "populated");
  let submitted: unknown;
  await page.route(url => url.pathname === "/api/v1/payroll/runs/preview", route => route.fulfill({ json: preview }));
  await page.route(url => url.pathname === "/api/v1/payroll/runs" && url.search === "", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: created });
  });
  await page.route(`**/api/v1/payroll/runs/${created.id}`, route => route.fulfill({ json: { ...detail, run: created } }));
  try {
    await page.goto("/payroll/runs/new");
    await chooseRegular(page);
    await fits(page, `payroll-run-create/${width}`);
    await expectAxe(page, `payroll-run-create/${width}`);
    await page.screenshot({ path: test.info().outputPath(`create-${width}.png`) });
    await page.getByRole("button", { name: t("payroll.create.submit"), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/payroll/runs/${created.id}$`));
    expect(submitted).toEqual({ pay_group_id: preview.pay_group_id, kind: preview.kind });
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const [status, code] of [[409, "regular_run_exists"], [409, "idempotency_key_reused"], [403, "forbidden"], [422, "validation"]] as const) test(`run creation shows permanent ${code} without retry wording @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await mockScreen(page, payrollRunCreateScreen, "populated");
  await page.route(url => url.pathname === "/api/v1/payroll/runs/preview", route => route.fulfill({ json: preview }));
  await page.route(url => url.pathname === "/api/v1/payroll/runs", route => route.request().method() === "POST"
    ? route.fulfill({ status, json: failure(code) }) : route.fallback());
  try {
    await page.goto("/payroll/runs/new");
    await chooseRegular(page);
    await page.getByRole("button", { name: t("payroll.create.submit"), exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: t("requestOutcome.check"), exact: true })).toHaveCount(0);
    await fits(page, `payroll-run-create/${code}`);
    await expectAxe(page, `payroll-run-create/${code}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("a run never borrows a matching group id from a different legal entity", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await page.route(`**/api/v1/payroll/runs/${run.id}`, route => route.fulfill({ json: { ...detail, run: { ...run, legal_entity_id: payGroups.legal_entities[0]!.id } } }));
  try {
    await page.goto(`/payroll/runs/${run.id}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("list", { name: t("payroll.stages.title") })).toBeVisible();
    await expect(main).toContainText(t("payroll.rule.unknown"));
    await expect(main.getByText(payGroups.items[2]!.name, { exact: true })).toHaveCount(0);
    await expect(main).toContainText(payGroups.legal_entities[0]!.name!);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
