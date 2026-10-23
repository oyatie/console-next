import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { registerEmployee } from "./flows";
import { addDepts, openUnit, quickWorkplace } from "./helpers/structure";
import { tenantInSetup } from "./setup-flows";

// S8 bulk move in setup (final spec §1 S8, §4): a chosen 부서 inside another chosen one travels with it and the title
// counts both; only places that can take every chosen unit are offered; a name clash is resolved in place; the
// counts are exact; the move applies at once as one batch.

test("bulk move: four 부서 to another 사업장, one carried, a name clash renamed, exact counts", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "movestruct", "이동구조");
  await addDepts(admin, "본점", ["품질관리부", "설비보전팀", "생산관리팀"]);
  await addDepts(admin, "품질관리부", ["수입검사팀", "공정품질팀"]);
  await registerEmployee(admin, { name: "설비직원", unit: "설비보전팀" });
  await quickWorkplace(admin, /이동구조/, "아산공장", { road: "충청남도 아산시 탕정면 탕정로 212", zip: "31454" });
  await addDepts(admin, "아산공장", ["생산관리팀"]);
  const c = clickCounter();

  // 1. From one 부서's panel to the full page; three more are added the keyboard way (the chart's Shift+click twin).
  const qa = await openUnit(admin, "품질관리부");
  await c.click(qa.getByRole("button", { name: "이동" }).first());
  await expect(admin).toHaveURL(/\/org\/move\?ids=/);
  // org-21: more 부서 are added through the canonical searchable tree (본점's own 생산관리팀 is listed first).
  for (const n of ["공정품질팀", "설비보전팀", "생산관리팀"]) {
    await c.click(admin.getByRole("button", { name: "함께 이동할 부서 추가" }));
    await c.click(admin.getByRole("dialog", { name: "함께 이동할 부서 추가" }).getByRole("row", { name: new RegExp(`^${n}`) }).first());
  }
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("부서 4개 이동");
  await expect(admin.getByText("공정품질팀은 품질관리부 아래에 있어 함께 이동합니다. 실제로 이동하는 묶음은 3개입니다.")).toBeVisible();

  // 2. Only this 법인's places are offered; the current place is named and cannot be picked.
  const where = admin.getByRole("treegrid", { name: "어디로" });
  await expect(where.getByRole("row", { name: /^본점 지금 위치/ })).toHaveAttribute("aria-disabled", "true");
  const submit = admin.getByRole("button", { name: "부서 이동 4개 반영" });
  await expect(submit).toHaveAttribute("aria-disabled", "true");
  await c.click(where.getByRole("row", { name: /^아산공장/ }));

  // 3. 생산관리팀 already exists there: the move waits until it is resolved, here by moving it under a new name.
  await expect(admin.getByText("아산공장 아래에 “생산관리팀”(0명)이 이미 있습니다.")).toBeVisible();
  await expect(submit).toHaveAccessibleDescription("이름이 겹치는 부서 1개를 먼저 정합니다.");
  await c.click(admin.getByRole("button", { name: "이름 변경 후 이동" }));
  await admin.getByRole("textbox", { name: "생산관리팀의 새 이름" }).fill("평택생산관리팀");

  // 4. Exact counts: 5 units, 1 member whose 사업장 and 고용보험 unit change; each 사업장's headcount before and after.
  const totals = admin.getByRole("region", { name: "무엇이 어떻게 바뀌나" });
  for (const [label, n] of [["이동하는 부서", "5"], ["구성원", "1"], ["사업장이 바뀌는 사람", "1"], ["고용보험 단위가 바뀜", "1"]] as const)
    await expect(totals.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }).locator("xpath=preceding-sibling::dd[1]")).toHaveText(n);
  await expect(admin.getByRole("figure", { name: "이동 후 아산공장" })).toContainText("이동해 옴 · 이름 바뀜");
  await expectAccessible(admin, "bulk move (setup)");
  await c.click(submit);
  await expect(admin).toHaveURL(/\/org(\?|$)/);
  expect(c.done("move 4 departments with a clash")).toBeLessThanOrEqual(10);

  // 5. Applied at once: the renamed unit sits directly under 아산공장, its sub-units came along.
  const moved = await openUnit(admin, "평택생산관리팀");
  await expect(moved.getByRole("definition").filter({ hasText: "아산공장 · 사업장 바로 아래" })).toBeVisible();
  const qa2 = await openUnit(admin, "품질관리부");
  await expect(qa2.getByRole("definition").filter({ hasText: "아산공장 · 사업장 바로 아래" })).toBeVisible();
  await expect(qa2.getByRole("region", { name: "하위 부서 2" })).toBeVisible();
});
