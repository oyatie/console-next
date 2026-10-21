import { expect, type Browser } from "@playwright/test";
import { tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "../flows";

/** A new tenant opened by the vendor, and its ops account signed in for the first time: an empty setup phase. */
export async function openTenant(browser: Browser, slug: string, name: string) {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await expect(v.getByRole("button", { name: "고객 계정 개설" })).toBeVisible();
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill(name);
  await tenantSlugField(v).fill(unique(slug));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  return firstSignIn(browser, await takeCode(v));
}
