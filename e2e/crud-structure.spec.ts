import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { soloTenant } from "./chaos";
import { go, registerEmployee } from "./flows";
import { addDepts, openUnit, panel, sheet } from "./helpers/structure";
import { setupCompany, startOperations } from "./setup-flows";
import { box, leaveScreen } from "./structure-flows";


/** Opens the unit's end sheet from its panel's action (the same sheet the chart's ⋯ 「삭제 · 폐지」 and Del open). */
async function endSheet(page: Page, name: string, verb: "삭제" | "폐지") {
  const p = await openUnit(page, name);
  const act = p.locator("#act-dept-delete");
  await expect(act).toHaveText(new RegExp(verb));
  await act.click();
  const s = sheet(page, `${name} 삭제 · 폐지`);
  await expect(s).toBeVisible();
  await expect(s.getByText("확인 중…")).toHaveCount(0);
  return s;
}

test("a solo admin deletes a never-used 팀 and 부서 and dissolves a used one, in setup and after go-live", { tag: ["@first-run", "@regression", "@org"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "crudorg", "구조상사");
  await setupCompany(admin, "구조상사", "본사");
  await go(admin, "/org");
  await addDepts(admin, "본사", ["영업부", "총무부", "임시부"]);
  await addDepts(admin, "영업부", ["영업1팀"]);

  // Setup: 영업1팀 was never used — 삭제 is offered, 폐지 is not (and says why).
  let s = await endSheet(admin, "영업1팀", "삭제");
  await expect(s).toContainText("쓰인 적 없는 부서는 폐지하지 않고 삭제합니다");
  await expectAccessible(admin, "CRUD: end sheet of a never-used 팀");
  await s.getByRole("button", { name: "부서 1개 삭제" }).click();
  await expect(s).toBeHidden();
  await expect(admin.getByRole("status").filter({ hasText: "영업1팀을 지웠습니다" })).toBeAttached();
  await expect(box(admin, "영업1팀")).toHaveCount(0);

  // A person placed in 총무부: neither way is offered while they are there, each with its reason; nothing changes.
  await registerEmployee(admin, { name: "한사람", number: "CR-0001", hired: "2024-03-04", unit: "총무부" });
  await go(admin, "/org");
  await leaveScreen(admin); // the person page passed through is audited by its own specs
  s = await endSheet(admin, "총무부", "폐지");
  await expect(s).toContainText("배치된 적이 있는 사람이 1명 있어 삭제하지 않습니다");
  await expect(s).toContainText("구성원 1명이 아직 있습니다 · 먼저 전보하십시오");
  await expect(s.getByRole("link", { name: "구성원 1명 보기" })).toBeVisible();
  await expect(s.getByRole("button", { name: /총무부 (삭제|폐지)$/ })).toHaveCount(0);
  await expectAccessible(admin, "CRUD: end sheet refused with its reasons");
  await s.getByRole("button", { name: "닫기", exact: true }).last().click();

  // After go-live a mistaken 부서 is still deleted (not only proposed for dissolution), recorded as a governed change.
  await startOperations(admin);
  await go(admin, "/org");
  await leaveScreen(admin);
  s = await endSheet(admin, "임시부", "삭제");
  await s.getByRole("button", { name: "부서 1개 삭제" }).click();
  await expect(s).toBeHidden();
  await expect(box(admin, "임시부")).toHaveCount(0);

  // 부서장 and 부서 코드 after go-live (they were disabled: 「이 서버는 아직 받지 않습니다」).
  const p = await openUnit(admin, "총무부");
  await p.locator("#act-dept-code").click();
  await p.getByRole("textbox", { name: /부서 코드/ }).fill("GA-01");
  await p.getByRole("button", { name: "부서 정보 1개 변경" }).click();
  await expect(panel(admin, "총무부")).toContainText("GA-01");

  // With people still in it after go-live, 폐지 opens the one dissolution sheet that moves them (org-06: no sheet before it).
  const used = await openUnit(admin, "총무부");
  await used.locator("#act-dept-delete").click();
  await expect(sheet(admin, "총무부 폐지").getByRole("region", { name: /^본사 직속으로 1명$/ })).toBeVisible();
});
