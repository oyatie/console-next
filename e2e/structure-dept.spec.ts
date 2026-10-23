import { expect, test } from "@playwright/test";
import { box } from "./structure-flows";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { registerEmployee } from "./flows";
import { addDepts, openUnit, panel, quickWorkplace, sheet } from "./helpers/structure";
import { tenantInSetup } from "./setup-flows";

// S6 부서 in setup (final spec §1 S6, §4): the panel derives its 법인 and 사업장 from where it sits; its end sheet (CRUD:
// delete if never used, else 폐지) asks about its sub-부서 with nothing preselected and refuses what its people block, with
// the reason; merge hides other 법인 and disables the unit's own subtree. Everything from an empty tenant.

test("부서: panel, delete with the sub-units raised, merge into another workplace, people block a setup delete", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "deptstruct", "부서구조");
  await addDepts(admin, "본점", ["품질관리부", "설비보전팀"]);
  await addDepts(admin, "품질관리부", ["수입검사팀", "공정품질팀"]);
  // Registered while 본점 is the only 사업장 (the register form then needs no 사업장 pick).
  await registerEmployee(admin, { name: "공정직원", unit: "공정품질팀" });
  await quickWorkplace(admin, /부서구조/, "아산공장", { road: "충청남도 아산시 탕정면 탕정로 212", zip: "31454" });
  await addDepts(admin, "아산공장", ["품질팀"]);
  const c = clickCounter();

  // 1. The panel: where it sits (derived), its sub-부서, and each action with what it does.
  const qa = await openUnit(admin, "품질관리부");
  await expect(qa.getByRole("definition").filter({ hasText: "본점 · 사업장 바로 아래" })).toBeVisible();
  await expect(qa.getByRole("definition").filter({ hasText: "(위치로 정해짐)" })).toBeVisible();
  await expect(qa.getByRole("region", { name: "하위 부서 2" })).toContainText("수입검사팀");
  // Someone sits under it (공정품질팀), so it is not deleted outright (CRUD: decided by use); the panel's verb says 폐지.
  await expect(qa.getByRole("button", { name: "폐지" })).toHaveAccessibleDescription("구성원 1명이 아직 있습니다 · 먼저 전보하십시오");
  await expectAccessible(admin, "department panel");

  // 2. Its end sheet asks where its sub-부서 go, nothing chosen; 「함께」 is refused with the reason (its people), raising them
  //    one level up removes it.
  c.done("open");
  await c.click(qa.getByRole("button", { name: "폐지" }));
  const del = sheet(admin, "품질관리부 삭제 · 폐지");
  await expect(del.getByRole("radio", { checked: true })).toHaveCount(0);
  const confirm = del.getByRole("button", { name: "부서 1개 삭제" });
  await expect(confirm).toHaveAttribute("aria-disabled", "true");
  await expect(confirm).toHaveAccessibleDescription("하위 부서를 어떻게 할지 선택하면 삭제합니다");
  await expect(del.getByRole("radio", { name: /^함께 삭제/ })).toBeDisabled();
  await expectAccessible(admin, "delete department (initial)");
  await c.click(del.getByRole("radio", { name: /^한 단계 위로 이동/ }).locator("xpath=ancestor::label[1]"));
  await expect(del).toContainText("품질관리부가 삭제되고, 공정품질팀·수입검사팀은 본점 바로 아래로 올라갑니다.");
  await expectAccessible(admin, "delete department (answered)");
  await c.click(confirm);
  await expect(del).toBeHidden();
  // The chart redraws without it before the next step aims at a box.
  await expect(box(admin, "품질관리부")).toHaveCount(0);
  expect(c.done("delete a department, sub-units raised")).toBeLessThanOrEqual(4);
  const raised = await openUnit(admin, "수입검사팀");
  await expect(raised.getByRole("definition").filter({ hasText: "본점 · 사업장 바로 아래" })).toBeVisible();

  // 3. Merge into a 부서 of another 사업장: exact totals and the after-tree with text tags.
  const eq = await openUnit(admin, "설비보전팀");
  await c.click(eq.getByRole("button", { name: "통합" }));
  const merge = sheet(admin, "설비보전팀 통합");
  const targets = merge.getByRole("treegrid", { name: "어느 부서로" });
  await expect(targets.getByRole("row", { selected: true })).toHaveCount(0);
  await expect(targets.getByRole("row", { name: /^설비보전팀 이 부서/ })).toHaveAttribute("aria-disabled", "true");
  await c.click(targets.getByRole("row", { name: /^품질팀/ }));
  await expect(merge.getByRole("figure", { name: "통합 후 아산공장" })).toContainText("통합됨 · +0명");
  await expectAccessible(admin, "merge department");
  await c.click(merge.getByRole("button", { name: "부서 통합 1개 반영" }));
  await expect(merge).toBeHidden();
  expect(c.done("merge a department")).toBeLessThanOrEqual(4);
  await expect(box(admin, "설비보전팀")).toHaveCount(0);

  // 4. A 부서 with people: neither way is offered while they are there, each with its reason, and they are one link away.
  const pq = await openUnit(admin, "공정품질팀");
  await pq.getByRole("button", { name: "폐지" }).click();
  const del2 = sheet(admin, "공정품질팀 삭제 · 폐지");
  await expect(del2).toContainText("구성원 1명이 아직 있습니다 · 먼저 전보하십시오");
  await expect(del2.getByRole("link", { name: "구성원 1명 보기" })).toBeVisible();
  await expect(del2.getByRole("button", { name: /^공정품질팀 (삭제|폐지)$/ })).toHaveCount(0);
  await del2.getByRole("button", { name: "닫기", exact: true }).last().click();
  await expect(panel(admin, "공정품질팀")).toBeVisible();
});
