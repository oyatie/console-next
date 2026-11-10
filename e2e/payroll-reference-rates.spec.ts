// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go } from "./flows";
import { registerEntity, tenantBeforeSetup } from "./setup-flows";
import { apiOf, bearerOf } from "./helpers/api";

test("payroll reference renders the entity's live statutory register", { tag: ["@hr", "@regression"] }, async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const { admin } = await tenantBeforeSetup(browser, "rateread", "요율조회상사", false, "none");
  const token = bearerOf(admin);
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "요율조회상사");
  await admin.reload();
  await expect.poll(token).toMatch(/^Bearer /);
  const api = apiOf(admin, token);
  const groupsResponse = await api("/payroll/pay-groups");
  expect(groupsResponse.status()).toBe(200);
  const groups = await groupsResponse.json();
  const entity = groups.legal_entities[0].id as string;
  const response = await api(`/payroll/reference/rates?legal_entity_id=${entity}`);
  expect(response.status()).toBe(200);
  const rates = await response.json();
  expect(rates.adopted).toBe(true);
  expect(rates.items.length).toBeGreaterThan(0);
  const active = rates.items.find((item: { status: string }) => item.status === "ACTIVE");
  expect(active).toBeDefined();
  const wage = rates.items.find((item: { code: string; effective_from: string }) => item.code === "MINIMUM_WAGE" && item.effective_from === "2026-01-01");
  expect(wage.name).toBe("최저임금");
  expect(wage.value).toBe("시간급 10320원 · 월 환산액 2156880원");
  const scheduled = rates.items.find((item: { code: string; effective_from: string }) => item.code === "NATIONAL_PENSION_EMPLOYEE" && item.effective_from === "2027-01-01");
  expect(scheduled?.status).toBe("SCHEDULED");
  await go(admin, `/payroll/reference?entity=${entity}`);
  const grid = admin.getByRole("grid");
  for (const value of [wage.value, scheduled.value]) {
    const displayed = admin.getByText(value, { exact: true }).first();
    await expect.poll(async () => {
      if (await displayed.isVisible()) return true;
      await grid.evaluate(el => { el.scrollTop += el.clientHeight / 2; });
      return false;
    }, { intervals: [100] }).toBe(true);
    await displayed.scrollIntoViewIfNeeded();
  }
  await expect(admin.getByText("적용 예정", { exact: true }).first()).toBeVisible();
  await expect(admin.getByText(active.provenance_ko, { exact: false })).toHaveCount(0);
  await grid.evaluate(el => { el.scrollTop = 0; });
  await expect(admin.getByText(active.value, { exact: true }).first()).toBeVisible();
  await expect(admin.getByRole("link", { name: `${active.instrument_ko} · ${active.article_ko} · ${active.promulgation_ko}`, exact: true }).first()).toHaveAttribute("href", active.source_url);
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.emulateMedia({ colorScheme: "dark" });
  await admin.locator("html").evaluate(el => { el.dataset.theme = "dark"; });
  await expect(admin.getByText(active.value, { exact: true }).first()).toBeVisible();
  await expect.poll(() => admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await admin.screenshot({ path: testInfo.outputPath("reference-mobile-dark.png"), fullPage: true });
});
