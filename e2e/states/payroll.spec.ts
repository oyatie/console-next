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
          await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
        } else if (state === "held") {
          await expect(main.getByText(t("payroll.reference.held"), { exact: true }).first()).toBeVisible();
          await expect(main.getByText(rate.value, { exact: true })).toHaveCount(0);
          await expect(main.getByRole("link", { name: /모의 고시/ })).toHaveCount(0);
        } else {
          await expect(main.getByText(rate.value, { exact: true })).toBeVisible();
          await expect(main.getByRole("link", { name: `${rate.instrument_ko} · ${rate.article_ko} · ${rate.promulgation_ko}`, exact: true })).toHaveAttribute("href", rate.source_url);
          await expect(main.getByText(rate.provenance_ko, { exact: false })).toBeVisible();
        }
      } else if (state === "empty") {
        await expect(main.getByRole("region", { name: t("payroll.setup.title") })).toBeVisible();
        await expect(main.getByRole("region", { name: t("payroll.deadlines") })).toHaveCount(0);
      } else {
        for (const group of payGroups.items) await expect(main.getByRole("region", { name: group.name, exact: true })).toBeVisible();
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
