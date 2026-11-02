// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { AT, failure, id, screenAccess } from "../mock/fixtures";
import { payGroups } from "../mock/payroll";
import { payrollScreens } from "./payroll";

test.beforeAll(() => loadCatalog("ko"));
const text = (key: string) => t(key as Parameters<typeof t>[0]);
const run = { id: id(899), pay_group_id: id(812), legal_entity_id: id(801), source_label: "모의 신규 급여", period_start: "2026-10-01", period_end: "2026-10-31", status: "STAGED", calculation_enabled: false, created_at: AT, updated_at: AT };
const detail = { run, legal_basis: {}, source_summary: {}, lines: [], lines_total: 0, lines_limit: 50, lines_offset: 0, exceptions_open: 0, exceptions_total: 0, calculation: null, disbursement: null, payslip_delivery: null };
const submit = () => t("composer.commit", { action: text("composer.action.payrollRun"), verb: t("composer.verb.save") });
async function fill(page: Page) {
  await page.getByLabel(text("payroll.create.group"), { exact: false }).selectOption(run.pay_group_id);
  await page.getByLabel(t("payroll.runName"), { exact: false }).fill(run.source_label);
  for (const [key, date] of [["start", run.period_start], ["end", run.period_end]]) {
    const input = page.getByRole("textbox", { name: text(`payroll.create.${key}`), exact: false });
    await input.fill(date!);
    await input.press("Tab");
  }
}

for (const [width, colorScheme] of [[1440, "light"], [390, "dark"]] as const) test(`explicit run creation opens its read-only rail at ${width}px ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await page.route("**/api/v1/access/me", route => route.fulfill({ json: screenAccess("/payroll/runs/new") }));
  const writes: { body: unknown; key: string | undefined }[] = [];
  await page.route(`**/api/v1/payroll/runs/${run.id}`, route => route.fulfill({ json: detail }));
  await page.route("**/api/v1/payroll/runs", route => {
    if (route.request().method() === "GET") return route.fallback();
    writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    return route.fulfill({ status: 201, json: run });
  });
  try {
    await page.goto("/payroll");
    await expect(page.getByRole("main").getByRole("link", { name: text("payroll.create.title"), exact: true })).toHaveCount(1);
    await fits(page, `payroll-home/${width}`);
    await expectAxe(page, `payroll-home/${width}`);
    await page.screenshot({ path: test.info().outputPath(`home-${width}.png`) });
    await page.getByRole("main").getByRole("link", { name: text("payroll.create.title"), exact: true }).click();
    const main = page.getByRole("main");
    await expect(main.getByRole("combobox")).toHaveValue("");
    for (const input of await main.getByRole("textbox").all()) await expect(input).toHaveValue("");
    const choices = main.getByRole("combobox").getByRole("option");
    await expect(choices).toHaveCount(payGroups.items.length + 1);
    for (const group of payGroups.items) await expect(choices.filter({ hasText: group.name })).toHaveCount(1);
    await main.getByRole("button", { name: submit(), exact: true }).click();
    await expect(main.getByRole("alert")).toContainText(text("payroll.create.required"));
    expect(writes).toEqual([]);
    await fill(page);
    await fits(page, `payroll-create/${width}`);
    await expectAxe(page, `payroll-create/${width}`);
    await page.screenshot({ path: test.info().outputPath(`create-${width}.png`) });
    await main.getByRole("button", { name: submit(), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/payroll/runs/${run.id}$`));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ pay_group_id: run.pay_group_id, source_label: run.source_label, period_start: run.period_start, period_end: run.period_end });
    expect(writes[0]!.key).toMatch(/^[\da-f-]{36}$/);
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(run.source_label);
    await expect(main).toContainText(payGroups.items[2]!.name);
    await expect(main).toContainText(payGroups.legal_entities[1]!.name!);
    const rail = main.getByRole("list", { name: text("payroll.stages.title") });
    await expect(rail.getByRole("listitem")).toHaveCount(6);
    for (const step of ["attendance", "calculate", "exceptions", "approval", "payment", "delivery"])
      await expect(rail).toContainText(text(`payroll.stage.${step}`));
    await expect(rail.locator('[aria-current="step"]')).toHaveText(text("payroll.stage.attendance"));
    await expect(rail.getByRole("link").or(rail.getByRole("button"))).toHaveCount(0);
    await fits(page, `payroll-run/${width}`);
    await expectAxe(page, `payroll-run/${width}`);
    await page.screenshot({ path: test.info().outputPath(`run-${width}.png`) });
    await page.reload();
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(run.source_label);
    expect(writes).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const state of ["empty", "loading", "failed", "refused", "missing"] as const) for (const screen of ["create", "run"] as const) test(`${screen}: ${state} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(screen === "create" ? "**/api/v1/payroll/pay-groups" : `**/api/v1/payroll/runs/${run.id}`, async route => {
    if (state === "loading") await held;
    if (page.isClosed()) return;
    if (state === "failed" || state === "refused" || state === "missing") return route.fulfill({ status: state === "failed" ? 500 : state === "refused" ? 403 : 404, json: failure(state === "failed" ? "internal_error" : state === "refused" ? "forbidden" : "not_found") });
    return route.fulfill({ json: screen === "create" ? { ...payGroups, items: [] } : detail });
  });
  try {
    await page.goto(screen === "create" ? "/payroll/runs/new" : `/payroll/runs/${run.id}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(screen === "create" ? text("payroll.create.title") : state === "empty" ? run.source_label : t("payroll.runName"));
    if (state === "loading") await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
    else if (state === "refused") await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
    else if (state === "failed") await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible({ timeout: 15_000 });
    else if (state === "missing") await expect(main).toContainText(t("common.read.notFound.title"));
    else if (screen === "create") {
      await expect(main).toContainText(text("payroll.create.noGroups"));
      await expect(main.getByRole("button", { name: submit(), exact: true })).toHaveCount(0);
    } else await expect(main.getByRole("heading", { level: 1 })).toHaveText(run.source_label);
    if (state !== "empty") await expect(main.getByRole("list", { name: text("payroll.stages.title") })).toHaveCount(0);
    await fits(page, `${screen}/${state}`);
    await expectAxe(page, `${screen}/${state}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); release(); fixture.release(); }
});

for (const status of [403, 409, 500]) test(`create refusal ${status} keeps the form and sends one command`, async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  let writes = 0;
  await page.route("**/api/v1/payroll/runs", route => {
    if (route.request().method() === "GET") return route.fallback();
    writes++;
    return route.fulfill({ status, json: failure(status === 403 ? "forbidden" : status === 409 ? "conflict" : "internal_error") });
  });
  try {
    await page.goto("/payroll/runs/new");
    await fill(page);
    await page.getByRole("button", { name: submit(), exact: true }).click();
    await expect(page.getByRole("main").getByRole(status === 500 ? "status" : "alert").first()).toBeVisible();
    if (status === 500) await expect(page.getByRole("button", { name: submit(), exact: true })).toBeDisabled();
    await expect(page.getByLabel(t("payroll.runName"), { exact: false })).toHaveValue(run.source_label);
    await expect(page.getByRole("main").getByRole("combobox")).toHaveValue(run.pay_group_id);
    await expect(page).toHaveURL(/\/payroll\/runs\/new$/);
    expect(writes).toBe(1);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("read-only effective access cannot open creation or show its home link", async ({ page }) => {
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  await page.route("**/api/v1/access/me", route => route.fulfill({ json: screenAccess("/payroll") }));
  try {
    await page.goto("/payroll");
    await expect(page.getByRole("main").getByRole("link", { name: text("payroll.create.title"), exact: true })).toHaveCount(0);
    await page.goto("/payroll/runs/new");
    await expect(page.getByRole("main").getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
    await expect(page.getByRole("main").getByRole("combobox")).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
