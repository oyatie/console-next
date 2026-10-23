import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { chooseRadio, registerEmployee } from "./flows";
import { addDepts, openUnit, quickWorkplace, sheet } from "./helpers/structure";
import { startOperations, tenantInSetup } from "./setup-flows";
import { box, leaveScreen } from "./structure-flows";
import { expectComposer } from "./helpers/composer";

// 운영 중 (final spec D12, S5-close, S6-add-governed, S6-dissolve-governed, S8-governed): the same actions open a
// change — 시행일 with no default, 사유; with no 결재 (decisions #26) a change dated today applies at submit — and an empty 사업장 closes on a date.

test("operating: new department and dissolution proposals, a governed move, deleting a never-used workplace", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "govstruct", "기안구조");
  await addDepts(admin, "본점", ["인사부", "영업팀"]);
  await registerEmployee(admin, { name: "인사직원", unit: "인사부" });
  await quickWorkplace(admin, /기안구조/, "판교지점", { road: "경기도 성남시 분당구 판교역로 166", zip: "13529" });
  await quickWorkplace(admin, /기안구조/, "닫을지점", { road: "서울특별시 중구 세종대로 110", zip: "04524" });
  await startOperations(admin);
  await leaveScreen(admin); // the 법인 and people screens passed through are audited by their own specs
  const c = clickCounter();

  // 1. 부서 신설: the same 「부서 추가」 opens an org change; nothing is dated for you.
  const main = await openUnit(admin, "본점");
  await expect(main.getByRole("button", { name: "부서 추가" })).toHaveAccessibleDescription("운영 중 · 부서 신설을 조직 변경으로 기록합니다");
  await c.click(main.getByRole("button", { name: "부서 추가" }));
  const add = sheet(admin, "부서 신설");
  const submitAdd = add.getByRole("button", { name: "부서 신설 1개 반영" });
  await expect(submitAdd).toHaveAttribute("aria-disabled", "true");
  await add.getByLabel("부서 이름").fill("마케팅팀");
  // A free name is accepted silently (no standing hint, 5bfb1b2cc): only the date and the reason are left.
  await expect(add.getByLabel("부서 이름")).not.toHaveAttribute("aria-invalid", "true");
  await expect(add).toContainText("시행일, 사유가 남아 아직 반영할 수 없습니다");
  await c.click(add.getByRole("button", { name: /^오늘/ }));
  await add.getByLabel("사유").fill("마케팅 기능 신설");
  await expectComposer(add, "부서 신설 1개 반영");
  await expectAccessible(admin, "new department proposal");
  await c.click(submitAdd);
  // org-19: the user stays on the chart; the receipt names the change and links its record.
  await expect(admin).toHaveURL(/\/org(\?|$)/);
  await expect(admin.getByRole("status").filter({ hasText: "마케팅팀 신설을 반영했습니다" })).toBeVisible();
  expect(c.done("propose a new department")).toBeLessThanOrEqual(4);

  // 2. 부서 폐지: one sheet (org-06), what must be decided first — where its member goes (the parent, here the 사업장
  //    itself, by default), the head post, the grants — then the date and reason; one change moves and closes.
  const hr = await openUnit(admin, "인사부");
  await hr.getByRole("button", { name: "부서 폐지", exact: true }).click();
  const dissolve = sheet(admin, "인사부 폐지");
  // The user stayed on the chart (org-19), so the chart behind the opening sheet re-fits once to the gutter its receipt
  // took (ChartView on `?act=`), under the sheet's backdrop. The sheet is the screen measured here.
  await expect(dissolve).toBeVisible();
  await leaveScreen(admin);
  const submitDissolve = dissolve.getByRole("button", { name: "부서 폐지 1개 반영" });
  await expect(submitDissolve).toHaveAccessibleDescription(/시행일, 사유/);
  await expect(dissolve.getByRole("region", { name: "본점 직속으로 1명" })).toBeVisible();
  await dissolve.getByRole("button", { name: /^오늘/ }).click();
  await dissolve.getByLabel("사유").fill("인사 기능을 본사 직속으로");
  await expectComposer(dissolve, "부서 폐지 1개 반영");
  await expect(dissolve).toContainText("직속 구성원 1명이 지정한 곳으로 각자 전보되며");
  await expectAccessible(admin, "dissolution proposal");
  await submitDissolve.click();
  await expect(admin.getByRole("status").filter({ hasText: "인사부 폐지를 반영했습니다" })).toBeVisible();
  await expect(box(admin, "인사부")).toHaveCount(0);

  // 3. A governed move: the page asks for the change's date and reason and counts it as one item.
  const sales = await openUnit(admin, "영업팀");
  await sales.getByRole("button", { name: "이동" }).first().click();
  await admin.getByRole("treegrid", { name: "어디로" }).getByRole("row", { name: /^판교지점/ }).click();
  await admin.getByRole("button", { name: /^오늘/ }).click();
  await admin.getByLabel("사유").fill("판교 영업 거점");
  await expect(admin.getByText(/조직 변경 1건\(항목 1개 · 이동 1 · 이름 0\)/)).toBeVisible();
  await expectAccessible(admin, "bulk move (operating)");
  await admin.getByRole("button", { name: "부서 이동 1개 반영" }).click();
  await expect(admin).toHaveURL(/\/org(\?|$)/);
  await expect(admin.getByRole("status").filter({ hasText: "영업팀을 판교지점 아래로 이동을 반영했습니다" })).toBeVisible();

  // 4. A 사업장 nobody ever used is deleted after go-live too (CRUD: decided by use; regression: only 폐쇄 was offered).
  const closing = await openUnit(admin, "닫을지점");
  await expect(closing.getByRole("button", { name: "삭제" })).toHaveAccessibleDescription("쓰인 적 없는 사업장 · 기록에서 삭제합니다");
  await closing.getByRole("button", { name: "삭제" }).click();
  const del = sheet(admin, "닫을지점 삭제");
  await chooseRadio(del, /^연습으로 넣음/);
  await expectAccessible(admin, "delete a never-used workplace (operating)");
  await del.getByRole("button", { name: "닫을지점 삭제" }).click();
  await expect(del).toBeHidden();
  await expect(box(admin, "닫을지점")).toHaveCount(0);
});
