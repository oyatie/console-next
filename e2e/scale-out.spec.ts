import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantOnboardSubmit, tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { homeRail } from "./setup-flows";

test("an isolated fresh stack serves the tenant setup through the cached web build", { tag: "@smoke" }, async ({ browser }) => {
  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설" }).click();
  await vendor.getByLabel("고객 이름").fill("빌드 검증");
  await tenantSlugField(vendor).fill(unique("scaleout"));
  await tenantOnboardSubmit(vendor).click();
  const admin = await firstSignIn(browser, await takeCode(vendor));
  await expect(await homeRail(admin)).toBeVisible();
  await expectAccessible(admin, "isolated tenant setup");
  await go(admin, "/");
  await expect(await homeRail(admin)).toBeVisible();
});
