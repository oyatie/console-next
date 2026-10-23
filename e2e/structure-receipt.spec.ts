import { expect, test } from "@playwright/test";
import { go } from "./flows";
import { openUnit, sheet } from "./helpers/structure";
import { tenantInSetup } from "./setup-flows";
import { addDepartments, box, receipt } from "./structure-flows";

// org-13 (UX-R2 ENDS): the chart's receipt belongs to the latest action. A 부서 erased from its panel's sheet ends the
// earlier receipt, so its 되돌리기 can never silently reverse an older change (an erase in setup has no undo on purpose,
// CRUD's hard-delete rule). regression: on the parent the 「…만들었습니다 · 되돌리기」 receipt stayed docked after the erase.

test("regression: an erase from the panel ends the chart's earlier receipt (org-13)", { tag: ["@regression", "@org"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "receipt13", "영수회사", false, "본사");
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["임시팀"]);
  await addDepartments(admin, "본사", ["개발팀"]);
  await expect(receipt(admin).first()).toContainText("개발팀");

  const p = await openUnit(admin, "임시팀");
  await p.locator("#act-dept-delete").click();
  const s = sheet(admin, "임시팀 삭제 · 폐지");
  await expect(s.getByText("확인 중…")).toHaveCount(0);
  await s.getByRole("button", { name: "부서 1개 삭제" }).click();
  await expect(s).toBeHidden();
  await expect(box(admin, "임시팀")).toHaveCount(0);
  // The older receipt is gone with its undo; what it recorded stays.
  await expect(receipt(admin)).toHaveCount(0);
  await expect(box(admin, "개발팀")).toBeVisible();
});

// The erased-unit view should close without re-reading the deleted resource.
test.fixme("an erase never re-reads the erased unit (org-13)", { tag: ["@regression", "@org"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "receipt13b", "영수회사", false, "본사");
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["임시팀"]);
  const missing: string[] = [];
  admin.on("response", (r) => {
    if (r.status() === 404 && /\/org-structure\/units\/|\/org-units\//.test(r.url())) missing.push(r.url());
  });
  const p = await openUnit(admin, "임시팀");
  await p.locator("#act-dept-delete").click();
  const s = sheet(admin, "임시팀 삭제 · 폐지");
  await expect(s.getByText("확인 중…")).toHaveCount(0);
  await s.getByRole("button", { name: "부서 1개 삭제" }).click();
  await expect(box(admin, "임시팀")).toHaveCount(0);
  await admin.waitForLoadState("networkidle");
  expect(missing).toEqual([]);
});
