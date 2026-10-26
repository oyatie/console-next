// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";

// The production served build deliberately has no component gallery.
test.skip(process.env.E2E_SERVED === "1", "the component gallery is dev-only");
test.beforeEach(async ({ page }) => { await page.goto("/_gallery"); });

test("failed form submit focuses a two-field summary whose links focus the actual inputs", async ({ page }) => {
  const form = page.locator("form").filter({ has: page.locator("#name-field") });
  const summary = form.locator('[data-component="error-summary"]');
  await expect(summary).toHaveCount(0);
  await form.locator('input[type="checkbox"]').check();
  await form.locator('button[type="submit"]').click();
  await expect(summary).toBeFocused();
  await expect(summary.locator("a")).toHaveCount(2);
  for (const id of ["name-field", "number-field"]) {
    await summary.locator(`a[href="#${id}"]`).click();
    await expect(page.locator(`#${id}`)).toBeFocused();
    await page.locator(`#${id}`).fill("SYNTHETIC0001");
  }
  await expect(summary).toHaveCount(0);
});

test("success, then clear the field keeps focus in the input", { tag: ["@journey:form-validation", "@tier:pr"] }, async ({ page }) => {
  const name = page.locator("#name-field");
  const form = page.locator("form").filter({ has: name });
  const summary = form.locator('[data-component="error-summary"]');
  await form.locator('input[type="checkbox"]').check();
  const submit = form.locator('button[type="submit"]');
  await submit.click();
  await expect(summary).toBeFocused();
  await name.fill("Synthetic value");
  await page.locator("#number-field").fill("SYNTHETIC0001");
  await submit.click();
  await expect(form.getByRole("status")).toBeVisible();
  await name.fill("");
  await expect(name).toBeFocused();
  await expect(summary).toHaveCount(0);
  await name.pressSequentially("김철수");
  await expect(name).toHaveValue("김철수");
  await expect(name).toBeFocused();
  await name.fill("");
  await submit.click();
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link")).toHaveCount(1);
});
