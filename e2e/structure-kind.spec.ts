import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, registerEmployee } from "./flows";
import { addDepts, openUnit, panel, quickWorkplace, sheet } from "./helpers/structure";
import { startOperations, tenantInSetup } from "./setup-flows";

// 회사 구조, ENT-KIND MR-19/20 and CS-BE: a 사업장 is added through its 법인 (never an org change), its kind is a label
// picked from the tenant's list (S5-kind-manage), its code and its place among its 법인's 사업장 are set on its panel,
// and a 부서's head and code are set in setup in one batch, with its sub-부서 in the order the tenant gives them.
test("사업장 kind, code and order; 부서 head, code and order; a new 사업장 through its 법인", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "kindco", "종류상사");
  await addDepts(admin, "본점", ["인사부"]);
  await addDepts(admin, "인사부", ["채용팀", "교육팀"]);
  await registerEmployee(admin, { name: "한부서", unit: "인사부" });

  // 1. The 법인 box's 「사업장 추가」 on the chart opens that 법인's add sheet over the chart, not an org change.
  await go(admin, "/org");
  const entity = admin.getByRole("tree", { name: /조직도$/ }).getByRole("treeitem", { name: /종류상사, 법인,/ });
  await entity.click();
  await admin.getByRole("toolbar", { name: /종류상사 작업$/ }).getByRole("link", { name: "사업장 추가", exact: true }).click();
  await expect(sheet(admin, "사업장 추가")).toBeVisible();
  await sheet(admin, "사업장 추가").getByRole("button", { name: "취소" }).click();
  await expect(sheet(admin, "사업장 추가")).toBeHidden();

  // 2. A 사업장's kind changes from its panel at once; nothing is preselected.
  const main = await openUnit(admin, "본점");
  await expect(main.getByRole("definition").filter({ hasText: "사업장 · 이름표일 뿐" })).toBeVisible();
  await main.getByRole("button", { name: "종류 수정" }).click();
  const kind = sheet(admin, "본점 종류 변경");
  await expect(kind.getByRole("button", { name: "종류 변경" })).toHaveAttribute("aria-disabled", "true");
  await kind.getByRole("radiogroup", { name: /^종류/ }).getByText("공장", { exact: true }).click();
  await expectAccessible(admin, "change a workplace's kind");
  await kind.getByRole("button", { name: "종류 변경" }).click();
  await expect(kind).toBeHidden();
  await expect(main.getByRole("definition").filter({ hasText: "공장 · 이름표일 뿐" })).toBeVisible();

  // 3. The kind list: a kind in use is not hidden and says why; a label any kind shows (a default's included) is refused
  // before it is sent; a default renamed goes back to its own name; an unused tenant kind hides and shows again.
  await main.getByRole("button", { name: "종류 수정" }).click();
  await kind.getByRole("button", { name: "사업장 종류 관리" }).click();
  const list = sheet(admin, "사업장 종류 관리");
  await expect(list.getByRole("row", { name: /^공장/ })).toContainText("1곳");
  await expect(list.getByRole("button", { name: "공장 숨기기" })).toHaveAttribute("aria-disabled", "true");
  await expect(list).toContainText("사업장 1곳이 쓰고 있어 숨길 수 없습니다");
  await list.getByRole("button", { name: "매장 이름 변경" }).click();
  await list.getByRole("textbox", { name: /^매장의 새 이름/ }).fill("공장");
  await expect(list).toContainText("이미 있는 종류 이름입니다: 공장");
  await list.getByRole("textbox", { name: /^매장의 새 이름/ }).fill("직영매장");
  await list.getByRole("button", { name: "저장", exact: true }).click();
  await expect(list.getByRole("row", { name: /^직영매장/ })).toBeVisible();
  const renameAt = await list.getByRole("button", { name: "직영매장 이름 변경" }).boundingBox();
  await list.getByRole("button", { name: "기본 이름(매장)으로" }).click();
  await expect(list.getByRole("row", { name: /^매장/ })).toBeVisible();
  expect((await list.getByRole("button", { name: "매장 이름 변경" }).boundingBox())?.x).toBe(renameAt!.x);
  await list.getByRole("button", { name: "종류 추가" }).click();
  await list.getByRole("textbox", { name: /^새 종류 이름/ }).fill("매장");
  await expect(list).toContainText("이미 있는 종류 이름입니다: 매장");
  await list.getByRole("textbox", { name: /^새 종류 이름/ }).fill("아울렛");
  await list.getByRole("button", { name: "종류 추가", exact: true }).click();
  await expect(list.getByRole("row", { name: /^아울렛/ })).toContainText("직접 추가");
  await expectAccessible(admin, "workplace kind list");
  await list.getByRole("button", { name: "아울렛 숨기기" }).click();
  await expect(list.getByRole("row", { name: /^아울렛/ })).toContainText("숨김");
  await list.getByRole("button", { name: "아울렛 다시 보이기" }).click();
  await expect(list.getByRole("row", { name: /^아울렛/ })).not.toContainText("숨김");
  await list.getByRole("button", { name: "닫기", exact: true }).last().click();
  await expect(list).toBeHidden();

  // 4. The 사업장 code: checked as typed, set at once, read back on the panel.
  await main.getByRole("button", { name: "사업장 코드 수정" }).click();
  const code = main.getByRole("textbox", { name: /^본점의 사업장 코드/ });
  await code.fill("HQ 01");
  await expect(main).toContainText("영문·숫자와 . _ - 만 쓸 수 있고 30자까지입니다");
  await code.fill("HQ-01");
  await main.getByRole("button", { name: "저장", exact: true }).click();
  await expect(main.getByRole("definition").filter({ hasText: "HQ-01" })).toBeVisible();

  // 5. A second 사업장: the first moves below it, and the panel says where it stands.
  await quickWorkplace(admin, /종류상사/, "판교지점", { road: "경기도 성남시 분당구 판교역로 166", zip: "13529" });
  const first = await openUnit(admin, "본점");
  await expect(first).toContainText("종류상사에서 2곳 중 1번째");
  await first.getByRole("button", { name: "본점 아래로" }).click();
  await expect(first).toContainText("종류상사에서 2곳 중 2번째");
  await expect(first.getByRole("button", { name: "본점 아래로" })).toBeDisabled();

  // 6. 부서: its sub-부서 in the tenant's order; its head (a member, dated today) and code set together in setup.
  const hr = await openUnit(admin, "인사부");
  await expect(hr.getByRole("listitem").first()).toContainText("교육팀"); // by name until an order is given
  await hr.getByRole("button", { name: "채용팀 위로" }).click();
  await expect(hr.getByRole("listitem").first()).toContainText("채용팀");
  await expect(hr.getByRole("definition").filter({ hasText: "공석" }).first()).toBeVisible();
  await hr.getByRole("button", { name: "부서장 수정" }).click();
  await hr.getByRole("combobox", { name: /부서장/ }).fill("한부서");
  await admin.getByRole("option", { name: /한부서/ }).click();
  await hr.getByRole("textbox", { name: /^부서 코드/ }).fill("HR");
  await expectAccessible(admin, "department head and code (setup)");
  await hr.getByRole("button", { name: "부서 정보 1개 변경", exact: true }).click();
  await expect(hr.getByRole("definition").filter({ hasText: /한부서 · .*부터/ })).toBeVisible();
  await expect(hr.getByRole("definition").filter({ hasText: /^HR$/ })).toBeVisible();

  // 7. After 운영 시작 the head and code still change at once (CRUD; regression: they were disabled, 「이 서버는 아직 받지
  //    않습니다」), recorded as a governed change while the tenant does not route org changes.
  await startOperations(admin);
  const after = await openUnit(admin, "인사부");
  await after.getByRole("button", { name: "부서 코드 수정" }).click();
  await after.getByRole("textbox", { name: /^부서 코드/ }).fill("HR-1");
  await after.getByRole("button", { name: "부서 정보 1개 변경", exact: true }).click();
  await expect(panel(admin, "인사부").getByRole("definition").filter({ hasText: /^HR-1$/ })).toBeVisible();
});
