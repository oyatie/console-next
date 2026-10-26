// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, registerEmployee } from "./flows";
import { SETUP_DEPARTMENT, setupCompany } from "./setup-flows";
import { openTenant } from "./helpers/tenant";
import { apiOf, bearerOf } from "./helpers/api";
import { forgetResize } from "./stability";

test("form registration keeps RRN recording absent until its endpoint ships", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const page = await openTenant(browser, "rrnrecord", "기록정밀");
  const api = apiOf(page, bearerOf(page));
  await setupCompany(page, "기록정밀", "본사");
  await registerEmployee(page, { name: "한기록", number: "RE-0001", unit: SETUP_DEPARTMENT });
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const response = await api(`/employees/${id}/rrn`);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ employee_id: id, recorded: false, masked: null });
  for (const suffix of ["", "/identifiers"]) {
    await go(page, `/people/${id}${suffix}`);
    const section = page.getByRole("region", { name: suffix ? "주민등록번호" : "인적사항", exact: true });
    await expect(section.getByText("기록 없음", { exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "기록", exact: true })).toHaveCount(0);
    if (!suffix) await expect(section.getByRole("link", { name: "사번·주민등록번호 ›" })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await forgetResize(page);
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, theme) => { el.dataset.theme = theme; }, theme);
        await expectAccessible(page, `RRN pending ${suffix || "card"} ${width} ${theme}`);
      }
    }
  }
});
