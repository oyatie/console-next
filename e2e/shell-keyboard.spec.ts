import { expect, test } from "@playwright/test";
import { go, vendorPage } from "./flows";
import { openTenant } from "./helpers/tenant";
import { homeRail } from "./setup-flows";

test("the shared shell names its content and supports Tab and skip-link navigation on every route", { tag: "@regression" }, async ({ browser }) => {
  const admin = await openTenant(browser, "shellkeyboard", "키보드사업장");
  const vendor = await vendorPage(browser);
  for (const [page, path, title] of [[vendor, "/platform", "tenants-title"], [admin, "/", "home-title"], [admin, "/people", "people-title"], [admin, "/org", "structure-title"]] as const) {
    await go(page, path);
    await page.bringToFront();
    const main = page.getByRole("main");
    await expect(main).toHaveAccessibleName("본문");
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(main.getByRole("heading", { level: 1 })).toHaveAttribute("id", title);
    if (path === "/") await expect(await homeRail(page)).toBeVisible();
    await expect(main.getByRole("button", { disabled: false }).or(main.getByRole("link")).first()).toBeVisible();
    await page.getByRole("button", { name: "로그아웃", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(main).toBeFocused();
    await page.getByRole("link", { name: "본문 바로가기" }).focus();
    await page.keyboard.press("Enter");
    await expect(main).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(main.locator(":focus")).toHaveCount(1);
  }
  await admin.getByRole("combobox", { name: "언어", exact: true }).selectOption("en");
  await expect(admin.getByRole("main")).toHaveAccessibleName("Main content");
});
