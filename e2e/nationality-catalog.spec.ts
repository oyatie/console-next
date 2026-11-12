// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { expect, test } from "@playwright/test";
import { kstDate, registerEmployee } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { setupCompany, startOperations } from "./setup-flows";

test.beforeAll(() => loadCatalog("ko"));

test("nationality refuses unassigned country codes and saves an assigned code", { tag: ["@hr", "@negative"] }, async ({ browser }, testInfo) => {
  const page = await openTenant(browser, "countrycatalog", "국적상사");
  const api = apiOf(page, bearerOf(page));
  await setupCompany(page, "국적상사", "본사");
  await startOperations(page);
  await registerEmployee(page, { name: "국적인", number: "NC-0001", hired: kstDate(-30), unit: "본사" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "어두운 화면으로 전환", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const employee = new URL(page.url()).pathname.split("/").pop()!;
  const detail = await (await api(`/employees/${employee}`)).json() as { employee: { updated_at: string } };
  const refused = await api(`/employees/${employee}`, "PATCH", {
    expected_updated_at: detail.employee.updated_at,
    changes: { nationality: "ZZ" }, reason_code: "DATA_ENTRY_ERROR",
  });
  expect(refused.status()).toBe(422);
  expect(await codeOf(refused)).toBe("nationality_unknown");
  const unchanged = await (await api(`/employees/${employee}/personal-facts`)).json() as { nationality: string | null };
  expect(unchanged.nationality).toBeNull();
  await page.getByRole("button", { name: "국적 · 신분증 수정", exact: true }).click();
  const input = page.getByRole("textbox", { name: "국적 · 신분증", exact: true });
  await input.fill("vn");
  const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/v1/employees/${employee}`);
  await input.press("Enter");
  expect((await saved).status()).toBe(200);
  const facts = await (await api(`/employees/${employee}/personal-facts`)).json() as { nationality: string | null };
  expect(facts.nationality).toBe("VN");
  await expect(page.getByText(/국적 VN/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("nationality-mobile-dark.png"), fullPage: true });
});
