import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { setupCompany } from "./setup-flows";
import { box, leaveScreen, receipt } from "./structure-flows";

// The other ways into the same structure (mockups S1-jump, S2b, S2-registry, S2-chart-export): ⌘K, the outline with
// keyboard entry and list paste, the list with levels, find and selection, and export. From an empty tenant, UI only.

test.use({ viewport: { width: 1440, height: 900 } });

test("jump, outline, paste, list and export work on one structure", { tag: "@org" }, async ({ browser }) => {
  const c = clickCounter();
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("한울그룹");
  await tenantSlugField(v).fill(unique("hanul"));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const admin = await firstSignIn(browser, await takeCode(v));
  await setupCompany(admin, "한울", "평택공장");
  await leaveScreen(admin);

  // ⌘K: find the 사업장 by name, Enter lands on the chart with it selected (no single-key badges in the palette).
  await go(admin, "/");
  await admin.keyboard.press("Control+k");
  const palette = admin.getByRole("dialog", { name: "찾기·이동" });
  await palette.getByRole("searchbox").fill("평택");
  await expect(palette.getByRole("menuitem", { name: "평택공장", exact: true })).toBeVisible();
  await expect(palette.getByRole("menuitem", { name: /평택공장에 직원 등록/ })).toBeVisible();
  await expectAccessible(admin, "jump palette");
  await admin.keyboard.press("Enter");
  await expect(admin).toHaveURL(/\/org\?/);
  await expect(box(admin, "평택공장")).toHaveAttribute("aria-selected", "true");

  // The outline: Enter on the 사업장 row opens a new row; Enter saves and keeps typing; Tab nests while typing.
  await c.click(admin.getByRole("button", { name: "아웃라인" }));
  const outline = admin.getByRole("tree", { name: "아웃라인" });
  await c.click(outline.getByRole("treeitem", { name: /^평택공장/ }));
  await admin.keyboard.press("Enter");
  const row = outline.getByRole("textbox", { name: "평택공장 아래 새 부서 이름" });
  await row.fill("영업부");
  await row.press("Enter");
  await expect(outline.getByRole("treeitem", { name: /^영업부/ })).toBeVisible();
  await row.press("Tab");
  const nested = outline.getByRole("textbox", { name: "영업부 아래 새 부서 이름" });
  await nested.fill("영업1팀");
  await nested.press("Enter");
  await expect(outline.getByRole("treeitem", { name: /^영업1팀/ })).toBeVisible();
  await nested.press("Escape");
  await expect(box(admin, "영업부")).toBeVisible(); // the chart beside it follows
  await expectAccessible(admin, "outline beside the chart");
  expect(c.done("two 부서 by outline keyboard")).toBeLessThanOrEqual(2);

  // List paste: a tab-indented list becomes nested 부서 in one batch with one undo (2 clicks).
  await outline.getByRole("treeitem", { name: /^평택공장/ }).click();
  await c.click(admin.getByRole("button", { name: "목록 붙여넣기" }));
  const paste = admin.getByRole("dialog", { name: "목록 붙여넣기" });
  await paste.getByLabel("부서 목록").fill("생산부\n\t생산1팀\n\t생산2팀\n품질부\n영업부");
  await expect(paste).toContainText("같은 곳에 같은 이름이 있습니다");
  await paste.getByLabel("부서 목록").fill("생산부\n\t생산1팀\n\t생산2팀\n품질부");
  await expect(paste).toContainText("평택공장 아래에 부서 4개를 2단계로 추가합니다");
  await expectAccessible(admin, "list paste");
  await c.click(paste.getByRole("button", { name: "부서 4개 추가" }));
  await expect(receipt(admin).first()).toContainText("평택공장 아래에 부서 4개를 추가했습니다");
  expect(c.done("4 부서 by paste")).toBeLessThanOrEqual(2);
  await expect(outline.getByRole("treeitem", { name: /^생산2팀/ })).toBeVisible();

  // The list: every level as an indented tree, one level flat, find keeps the path.
  await admin.getByRole("button", { name: "목록", exact: true }).click();
  const list = admin.getByRole("grid", { name: "조직 구조 목록" });
  await expect(list.getByRole("row", { name: /생산1팀/ })).toBeVisible();
  await admin.getByRole("button", { name: /^부서 \d/ }).click();
  await expect(list.getByRole("row", { name: /평택공장/ })).toHaveCount(0);
  await expect(list.getByRole("row", { name: /품질부/ })).toBeVisible();
  for (const column of ["순서", "이름", "단계", "장", "코드", "인원", "직속", "미배치", "하위", "표시"])
    await expect(list.getByRole("columnheader", { name: column, exact: true })).toBeAttached();
  await expectAccessible(admin, "structure list");

  // Export: PDF/PNG, paper and orientation, the point-size guard, personal data off by default.
  await admin.getByRole("button", { name: "조직도", exact: true }).click();
  await admin.getByRole("button", { name: "내보내기" }).click();
  const sheet = admin.getByRole("dialog", { name: "조직도 내보내기" });
  await expect(sheet.getByRole("checkbox", { name: /개인 정보 제외/ })).not.toBeChecked();
  await expect(sheet.getByRole("status")).toContainText(/지금 글자 크기 [\d.]+pt/);
  await sheet.getByRole("radiogroup", { name: /방향/ }).getByText("세로", { exact: true }).click();
  await expect(sheet).toContainText("A3 세로");
  await expectAccessible(admin, "export");
  await sheet.getByRole("button", { name: "취소" }).click();
});
