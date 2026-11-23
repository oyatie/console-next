// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { id } from "../mock/fixtures";
import { mockPayroll, payGroups, rate } from "../mock/payroll";
import { payrollScreens, type PayrollState } from "./payroll";

test.beforeAll(() => loadCatalog("ko"));
for (const screen of payrollScreens) for (const state of Object.keys(screen.states) as PayrollState[]) for (const width of [1440, 390]) {
  if (screen.key === "payroll" && (state === "held" || state === "unsupported")) continue;
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [], writes: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/v1/payroll/") && request.method() !== "GET") writes.push(request.url()); });
    const fixture = await mockScreen(page, screen, state);
    const reference = screen.key === "payroll-reference";
    try {
      await page.goto(screen.path + (reference ? `?entity=${id(800)}` : ""));
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { level: 1, name: t(reference ? "payroll.reference.title" : "payroll.title"), exact: true })).toBeVisible();
      if (state === "loading") {
        await expect(main.locator('[data-read-layout="list"][aria-busy="true"]').last()).toBeVisible();
        await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
      } else if (reference) {
        if (state === "unsupported" || state === "empty") {
          await expect(main.getByText(t(state === "unsupported" ? "payroll.reference.noPack" : "payroll.reference.empty"), { exact: true })).toBeVisible();
          await expect(main.getByText(state === "unsupported" ? t("payroll.reference.noPackReason", { country: "US" }) : t("payroll.reference.emptyReason"), { exact: true })).toBeVisible();
          await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
        } else if (state === "held") {
          await expect(main.getByText(t("payroll.reference.held"), { exact: true }).first()).toBeVisible();
          await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
          await expect(main.getByRole("link").and(page.locator(`[href="${rate.source_url}"]`))).toHaveCount(0);
        } else {
          await expect(main.getByText(rate.value, { exact: true })).toBeVisible();
          await expect(main.getByRole("link", { name: `${rate.instrument_ko} · ${rate.article_ko} · ${rate.promulgation_ko}`, exact: true })).toHaveCount(0);
          await expect(main.getByText(`${rate.instrument_ko} · ${rate.article_ko} · ${rate.promulgation_ko} · ${new URL(rate.source_url).href}`, { exact: true })).toBeVisible();
          await expect(main.getByText(rate.provenance_ko, { exact: false })).toHaveCount(0);
        }
      } else if (state === "empty") {
        await expect(main.getByRole("region", { name: t("payroll.setup.title") })).toBeVisible();
      } else {
        for (const group of payGroups.items) {
          const card = main.getByRole("region", { name: group.name, exact: true });
          await expect(card).toBeVisible();
          for (const field of ["basePeriod", "variablePeriod", "payDateRule", "proration", "channel"] as const)
            await expect(card.getByText(t(`payroll.${field}`), { exact: true })).toBeVisible();
          await expect(card.getByText(t(`payroll.rule.${group.proration}`), { exact: true })).toBeVisible();
          await expect(card.getByText(t(`payroll.rule.${group.channel}`), { exact: true })).toBeVisible();
        }
        const overseas = main.getByRole("region", { name: payGroups.items[2]!.name, exact: true });
        await expect(overseas).toContainText("모의상사 해외법인");
        await expect(overseas).toContainText(t("payroll.run.VOID"));
        await expect(overseas).not.toContainText(t("payroll.run.STAGED"));
      }
      await fits(page, `${screen.key}/${state}/${width}`);
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      if (state === "loading" || state === "failed") {
        await mockPayroll(page, screen, "populated", Promise.resolve());
        fixture.release();
        if (state === "failed") await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await expect(reference ? main.getByText(rate.value, { exact: true }) : main.getByRole("region", { name: payGroups.items[0]!.name, exact: true })).toBeVisible();
      }
      expect(errors).toEqual([]);
      expect(writes).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("reference selection keeps unsupported entities separate and payroll readiness controls the rail", async ({ page }) => {
  const screen = payrollScreens[1];
  const fixture = await mockScreen(page, screen, "populated");
  await page.goto(screen.path);
  const main = page.getByRole("main");
  await expect(main.getByText(t("payroll.reference.pick"), { exact: true }).last()).toBeVisible();
  await main.getByRole("button", { name: t("payroll.entity"), exact: false }).click();
  await page.getByRole("option", { name: "모의상사 해외법인", exact: true }).click();
  await expect(main.getByText(t("payroll.reference.noPack"), { exact: true })).toBeVisible();
  await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
  const rail = page.getByRole("navigation", { name: t("shell.nav") });
  await expect(rail.getByRole("link", { name: t("payroll.title"), exact: true })).toBeVisible();
  await page.route("**/api/v1/onboarding/modules", route => route.fulfill({ json: [] }));
  await page.reload();
  await expect(main.getByText(t("payroll.reference.noPack"), { exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: t("payroll.title"), exact: true })).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("an unknown reference entity makes no rates request and can be replaced with an available entity", async ({ page }) => {
  const screen = payrollScreens[1];
  const fixture = await mockScreen(page, screen, "populated");
  const reads: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === screen.read) reads.push(url.searchParams.get("legal_entity_id")!);
  });
  try {
    await page.goto(`${screen.path}?entity=${id(899)}`);
    const main = page.getByRole("main");
    await expect(main.getByText(t("payroll.reference.pickReason"), { exact: true })).toBeVisible();
    const picker = main.getByRole("button", { name: t("payroll.entity"), exact: false });
    await expect(picker).toContainText(t("payroll.reference.pick"));
    await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
    expect(reads).toEqual([]);
    await picker.click();
    await page.getByRole("option", { name: payGroups.legal_entities[0]!.name!, exact: true }).click();
    await expect(main.getByText(rate.value, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${new URL(screen.path, page.url())}?entity=${id(800)}`);
    expect(reads).toEqual([id(800)]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("payroll home paginates over 100 runs with server pay_group_id filter @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockScreen(page, payrollScreens[0], "populated");
  const manyRuns = Array.from({ length: 120 }, (_, n) => ({
    id: id(9000 + n),
    legal_entity_id: payGroups.items[0]!.legal_entity_id,
    pay_group_id: payGroups.items[0]!.id,
    kind: "REGULAR" as const,
    attribution_month: `2026-${String((n % 12) + 1).padStart(2, "0")}`,
    pay_date: "2026-10-25",
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    variable_period_start: "2026-09-16",
    variable_period_end: "2026-10-15",
    source_label: `Synthetic bulk run ${n + 1}`,
    status: "CALCULATED" as const,
    calculation_enabled: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  }));
  const seenOffsets: number[] = [];
  await page.route(url => url.pathname === "/api/v1/payroll/runs", route => {
    const q = new URL(route.request().url()).searchParams;
    const groupId = q.get("pay_group_id");
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 50);
    if (groupId === payGroups.items[0]!.id) seenOffsets.push(offset);
    const matched = groupId === payGroups.items[0]!.id ? manyRuns : [];
    return route.fulfill({ json: { items: matched.slice(offset, offset + limit), total: matched.length, limit, offset } });
  });
  try {
    await page.goto("/payroll");
    const card = page.getByRole("region", { name: payGroups.items[0]!.name, exact: true });
    await expect(card).toBeVisible();
    const grid = card.getByRole("grid");
    await expect(grid).toBeVisible();
    await grid.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => seenOffsets).toContain(50);
    await grid.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => seenOffsets).toContain(100);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
