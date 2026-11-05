// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go } from "./flows";
import { openTenant } from "./helpers/tenant";
import { setupCompany } from "./setup-flows";
import { box, revealUnit } from "./structure-flows";

test("a saved department never flashes a duplicate warning while its tree refreshes", async ({ browser }) => {
  const page = await openTenant(browser, "deptvalidation", "부서등록");
  await setupCompany(page, "부서등록", "본사");
  await go(page, "/org");
  await revealUnit(page, "본사");
  await page.keyboard.press("a");
  const field = page.getByRole("textbox", { name: "본사 아래 새 부서 이름" });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/org-structure/change-dates?*", async route => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await field.fill("개발팀");
    await field.press("Enter");
    await expect(box(page, "개발팀")).toHaveCount(1);
    await expect(field).toBeDisabled();
    await expect(field).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert").filter({ hasText: "이미 있습니다" })).toHaveCount(0);
    release();
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await field.fill("개발팀");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert").filter({ hasText: "이미 있습니다" })).toHaveCount(1);
    await field.fill("인사팀");
    await field.press("Enter");
    await expect(box(page, "인사팀")).toHaveCount(1);
    await expect(field).toHaveValue("");
  } finally { release(); await page.context().close(); }
});
