import { expect, test } from "@playwright/test";
import { expectAccessible, fits as fitsOn } from "./a11y";
import { forgetResize } from "./stability";
import { go } from "./flows";
import { tenantWithExecutive } from "./setup-flows";
import { rosterXlsx } from "./workbook";
import { chooseWorkbook, payPeriod } from "./helpers/import";

test("an HR admin imports a roster: preview → dry run → apply bound to it", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await tenantWithExecutive(browser, "peopleco", "사람주식회사");
  await go(admin, "/people");
  await admin.getByRole("link", { name: "가져오기" }).first().click();

  await expect(admin.getByRole("heading", { name: "직원 명부 가져오기", level: 1 })).toBeVisible();
  await expectAccessible(admin, "import: upload");
  await chooseWorkbook(admin, "roster.xlsx", await rosterXlsx("사람주식회사", [
    ["E-001", "김하나", "인사팀", "과장", "2024-03-02"],
    ["E-002", "박둘", "영업팀", "대리", "2025-01-06"],
  ]));
  await payPeriod(admin);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await expect(admin.locator('[aria-current="step"]')).toHaveText("열 확인");
  await expectAccessible(admin, "import: column review");
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await expect(admin.locator('[aria-current="step"]')).toHaveText("모의 반영");
  await expectAccessible(admin, "import: dry run");
  await admin.getByRole("button", { name: "명부 반영: 신규 2명 · 갱신 0명" }).click();
  await expect(admin.getByRole("heading", { name: "반영했습니다" })).toBeVisible();
  await expectAccessible(admin, "import: applied");

  await admin.getByRole("link", { name: "직원 보기" }).click();
  await expect(admin.getByRole("rowheader", { name: "김하나", exact: true })).toBeVisible();
  await admin.getByRole("rowheader", { name: "김하나", exact: true }).click();
  const peek = admin.getByRole("complementary", { name: "직원 상세" });
  await expect(peek).toContainText("E-001");
  // Trunk's panel rows stay in the peek (regression: the peek dropped them once).
  for (const row of ["직무 · 직위", "기본급"]) await expect(peek.getByRole("term").filter({ hasText: row })).toBeVisible();
  await expectAccessible(admin, "people list + detail panel");

  // Phone width: the menu button discloses the navigation, and no screen scrolls sideways.
  await admin.setViewportSize({ width: 390, height: 844 });
  await forgetResize(admin);
  const fits = (screen: string) => fitsOn(admin, screen);
  await go(admin, "/");
  await expect(admin.getByRole("navigation", { name: "주 메뉴" })).toBeHidden();
  const menu = admin.getByRole("button", { name: "메뉴" });
  await menu.click();
  await expect(admin.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "홈" })).toBeFocused();
  await admin.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await menu.click();
  await admin.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "인사" }).click();
  await expect(admin.getByRole("rowheader", { name: "김하나", exact: true })).toBeVisible();
  await expect(admin.getByRole("navigation", { name: "주 메뉴" })).toBeHidden();
  await fits("people");
  await expectAccessible(admin, "people list at 390px");
  await menu.click();
  await admin.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "조직 구조" }).click();
  await expect(admin.getByRole("heading", { name: "조직 구조", level: 1 })).toBeVisible();
  await fits("org");
  await go(admin, "/people/new");
  await expect(admin.getByRole("dialog", { name: "직원 등록" })).toBeVisible();
  await fits("register employee (no unit yet)");
  await go(admin, "/people/import");
  await expect(admin.getByRole("button", { name: "파일 선택" })).toBeVisible();
  await fits("import");
});
