// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, takeCode, tenantSlugField, unique, vendorPage } from "./flows";

test("a legal hold refusal keeps the tenant and explains who can resolve it", { tag: "@regression" }, async ({ browser }) => {
  const page = await vendorPage(browser);
  const name = unique("보존고객");
  await go(page, "/platform");
  await page.getByRole("button", { name: "고객 계정 개설" }).click();
  await page.getByRole("dialog").getByLabel("고객 이름").fill(name);
  await tenantSlugField(page.getByRole("dialog")).fill(unique("held"));
  await page.getByRole("button", { name: "개설하고 코드 발급" }).click();
  await takeCode(page);
  const panel = page.getByRole("complementary", { name });
  const remove = `${name} 삭제`;
  // Transport refusal: real command-role and DB preservation are covered by remove_tenant.rs.
  await page.route("**/api/platform/orgs/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await route.fulfill({ status: 409, json: { error: { code: "blocked_legal_hold", message: "held" } } });
  });
  try {
    await panel.getByRole("button", { name: remove, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: remove, exact: true });
    await dialog.getByRole("button", { name: remove, exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("법적 보존 조치");
    await expect(dialog.getByRole("alert")).toContainText("보존 담당자");
    await expect(dialog.getByRole("button", { name: remove, exact: true })).toBeDisabled();
    await expectAccessible(page, "held tenant removal refusal");
    await dialog.getByRole("button", { name: "돌아가기" }).click();
    await expect(panel).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
});
