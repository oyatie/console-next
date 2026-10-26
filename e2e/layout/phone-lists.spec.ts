// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "../a11y";
import { go, registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { forgetResize } from "../stability";

test("people cards at 390px keep selection, focus and the open record through rotation", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "phone-lists", "모바일상사");
  await registerEmployee(admin, { name: "김모바일", number: "MOB-0001", position: "사원" });
  await admin.setViewportSize({ width: 1280, height: 720 });
  await go(admin, "/people");
  const grid = admin.getByRole("grid", { name: "직원", exact: true });
  const row = grid.getByRole("row").filter({ hasText: "MOB-0001" });
  await expect(row).toBeVisible();
  // m6 regression: the phone mechanism must leave every desktop column's budget intact.
  const widths = await grid.getByRole("columnheader").evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
  await atPhoneWidth(admin, async () => {
    await expect(grid).toHaveAttribute("data-layout", "cards");
    await fits(admin, "/people");
    await expect(row.getByText("MOB-0001", { exact: true })).toBeVisible();
    await expect(row.getByText("김모바일", { exact: true })).toBeVisible();
    await row.focus();
    await row.press("Space");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await row.press("Enter");
    const panel = admin.getByRole("complementary", { name: "직원 상세" });
    await expect(panel).toBeVisible();
    await expectAccessible(admin, "/people cards and open record");
    await row.focus();
    await admin.setViewportSize({ width: 844, height: 390 });
    await forgetResize(admin);
    await expect(grid).toHaveAttribute("data-layout", "rows");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toBeFocused();
    await expect(panel).toBeVisible();
    await admin.setViewportSize({ width: 390, height: 844 });
    await expect(grid).toHaveAttribute("data-layout", "cards");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toBeFocused();
    await expect(panel).toBeVisible();
  });
  expect(await grid.getByRole("columnheader").evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width))).toEqual(widths);
});
