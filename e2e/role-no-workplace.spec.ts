import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, routeReady } from "./flows";
import { tenantBeforeSetup } from "./setup-flows";

// Before any workplace an account still gets access (governance-01: no preset roles, so no 지점-bound title to block on):
// the colleague invited in setup holds a tenant role over 회사 전체, and the account panel shows access, not a title.
test("before any workplace, an invited colleague holds a 회사 전체 grant and no title", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await tenantBeforeSetup(browser, "nowp", "준비상사");
  await go(admin, "/people?view=accounts");
  await admin.getByRole("row", { name: /이임원/ }).click();
  await routeReady(admin);
  const panel = admin.getByRole("complementary", { name: "이임원" });
  await expect(panel.getByRole("button", { name: "역할 변경" })).toHaveCount(0);
  await panel.getByRole("link", { name: "이 사람이 할 수 있는 일" }).click();
  await expect(admin.getByRole("listitem").filter({ hasText: "조회·결재" })).toBeVisible();
  await expectAccessible(admin, "person access (no workplace)");

  // The company structure before any 법인 (regions retired, decisions #18): the first-run chart, and nothing shifts
  // under the layout guard.
  await go(admin, "/org");
  await expect(admin.getByRole("heading", { name: "첫 법인을 등록합니다" })).toBeVisible();
  await expectAccessible(admin, "company structure (nothing yet)");
});
