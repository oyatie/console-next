import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { registerEntity, registerWorkplace } from "./setup-flows";
import { addDepartments, box, findPressable, leaveScreen, receipt, revealUnit } from "./structure-flows";

// The company structure chart (mockups S10, S1, S2): from an empty tenant, through the UI only, the first run turns
// into the chart, and every 부서 gesture applies at once in setup with its undo. Click ceilings from spec §4.

// The mockups' desktop size (spec: 1440 × 900).
test.use({ viewport: { width: 1440, height: 900 } });

test("an empty tenant builds its structure on the chart", { tag: "@org" }, async ({ browser }) => {
  const c = clickCounter();
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("새온그룹");
  await tenantSlugField(v).fill(unique("saeon-chart"));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const admin = await firstSignIn(browser, await takeCode(v));

  // S10: the empty chart is the sequence, with the setup steps beside it.
  await go(admin, "/org");
  await expect(admin.getByRole("heading", { name: "첫 법인을 등록합니다" })).toBeVisible();
  await expect(admin.getByRole("complementary", { name: "시작", exact: true })).toBeVisible();
  await expectAccessible(admin, "structure first run");
  await c.click(admin.getByRole("link", { name: "법인 추가" }));
  await registerEntity(admin, "새온정밀", false, c);

  // S10-first-entity: the 법인 box with its next step in place.
  await go(admin, "/org");
  await expect(box(admin, "주식회사 새온정밀")).toBeVisible();
  await c.click(admin.getByRole("link", { name: "사업장 추가" }));
  await registerWorkplace(admin, "새온정밀", "평택공장", false, c);
  await go(admin, "/org");
  await leaveScreen(admin);
  await expect(box(admin, "평택공장")).toBeVisible();
  await expect(admin.getByRole("complementary", { name: "설정 진행" })).toBeVisible();
  await expectAccessible(admin, "structure chart (one entity)");
  c.done("first entity and workplace");

  // Inline add: A on the 사업장, then names with Enter (typing, no clicks).
  await addDepartments(admin, "평택공장", ["생산부", "품질부", "설비보전팀"]);
  await addDepartments(admin, "생산부", ["생산1팀", "생산2팀"]);
  await expect(receipt(admin)).toContainText("생산2팀을 추가했습니다");

  // F2 renames in place; a sibling name is refused as typed.
  await revealUnit(admin, "품질부");
  await admin.keyboard.press("F2");
  const rename = admin.getByRole("textbox", { name: "품질부의 새 이름" });
  await rename.fill("생산부");
  await expect(admin.getByRole("alert")).toContainText("같은 곳에 생산부가 이미 있습니다");
  await rename.fill("품질관리부");
  await rename.press("Enter");
  await expect(box(admin, "품질관리부")).toBeVisible();

  // M: the valid-only target tree (keyboard twin of drag): select → M → target → move.
  await revealUnit(admin, "생산1팀");
  await admin.keyboard.press("m");
  const picker = admin.getByRole("dialog", { name: "생산1팀 이동" });
  await expect(picker.getByRole("row", { name: /^생산1팀/ })).toHaveCount(0);
  await c.click(picker.getByRole("row", { name: /^품질관리부/ }));
  await expect(picker.getByRole("status")).toContainText("놓으면: 품질관리부 아래로");
  await expectAccessible(admin, "move picker");
  await c.click(picker.getByRole("button", { name: "품질관리부 아래로 이동" }));
  await expect(receipt(admin)).toContainText("생산1팀을 품질관리부로 옮겼습니다");
  expect(c.done("move one 부서 by keyboard (after finding it)")).toBeLessThanOrEqual(2);

  // 되돌리기 puts it back (the server's undo of that batch).
  await receipt(admin).getByRole("button", { name: "되돌리기" }).click();
  await expect(admin.getByRole("region", { name: "조직도" }).getByRole("status").filter({ hasText: "되돌렸습니다" })).toBeVisible();

  // Drag with only-valid targets: one gesture.
  await revealUnit(admin, "생산2팀");
  await box(admin, "생산2팀").dragTo(box(admin, "설비보전팀"));
  await expect(receipt(admin)).toContainText("생산2팀을 설비보전팀으로 옮겼습니다");

  // Delete (Del) asks first; a 부서 nobody was placed in is deleted (CRUD: decided by use).
  await revealUnit(admin, "생산2팀");
  await admin.keyboard.press("Delete");
  const del = admin.getByRole("dialog", { name: "생산2팀 삭제 · 폐지" });
  await del.getByRole("button", { name: "부서 1개 삭제" }).click();
  await expect(box(admin, "생산2팀")).toHaveCount(0);

  // Search to focus: type and Enter, no clicks; the current hit says so.
  const find = admin.getByRole("searchbox", { name: "조직 찾기" });
  await find.fill("관리");
  await find.press("Enter");
  await expect(admin.getByText("1 / 1 · 지금 보고 있는 결과")).toBeVisible();
  await expect(box(admin, "품질관리부")).toHaveAttribute("data-s", /now/);
  await find.press("Escape");

  // Several at once: Shift-click, then the selection bar.
  await revealUnit(admin, "설비보전팀");
  await findPressable(admin, "생산부");
  await box(admin, "생산부").click({ modifiers: ["Shift"] });
  const bar = admin.getByRole("region", { name: "선택한 조직" });
  await expect(bar).toContainText("2개 선택");
  await expectAccessible(admin, "structure chart (multi-select)");
  await bar.getByRole("button", { name: "선택 해제" }).click();

  // ⋯ menu (also right-click and Shift+F10) lists the verbs with their keys.
  await revealUnit(admin, "생산부");
  await box(admin, "생산부").click({ button: "right" });
  const menu = admin.getByRole("menu", { name: "생산부 더 보기" });
  await expect(menu.getByRole("menuitem")).toHaveText([/하위 부서 추가A/, /이름 변경F2/, /이동M/, /순서 뒤로Alt\+↓/, /통합/, /이 단위만 보기F/, /상세 열기Enter/, /삭제 · 폐지Del/]);
  await admin.keyboard.press("Escape");

  // The depth control and a focus on one 법인 (crumbs back to the whole).
  await revealUnit(admin, "주식회사 새온정밀");
  await admin.keyboard.press("f");
  await expect(admin.getByRole("navigation", { name: "보고 있는 위치" })).toContainText("주식회사 새온정밀");
  await admin.getByRole("button", { name: "부서 모두" }).click();
  await expect(box(admin, "생산1팀")).toBeVisible();
  await expectAccessible(admin, "structure chart (entity focus)");
  await admin.getByRole("button", { name: "전체 보기" }).click();
  await expect(admin.getByRole("tree", { name: "전체 조직도" })).toBeVisible();
});
