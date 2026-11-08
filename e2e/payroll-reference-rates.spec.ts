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
  await go(admin, `/payroll/reference?entity=${entity}`);
  await expect(admin.getByText(active.value, { exact: true }).first()).toBeVisible();
  await expect(admin.getByRole("link", { name: `${active.instrument_ko} · ${active.article_ko} · ${active.promulgation_ko}`, exact: true }).first()).toHaveAttribute("href", active.source_url);
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.emulateMedia({ colorScheme: "dark" });
  await admin.locator("html").evaluate(el => { el.dataset.theme = "dark"; });
  await expect(admin.getByText(active.value, { exact: true }).first()).toBeVisible();
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await admin.screenshot({ path: testInfo.outputPath("reference-mobile-dark.png"), fullPage: true });
});
