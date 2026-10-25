import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantOnboardSubmit, tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { pickKind, registerEntity, registerWorkplace, typeAddress } from "./setup-flows";
import { box, leaveScreen, revealUnit } from "./structure-flows";

async function emptyEntity(browser: Browser, slug: string, width = 1280, height = 720) {
  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설" }).click();
  await vendor.getByLabel("고객 이름").fill("자녀추가");
  await tenantSlugField(vendor).fill(unique(slug));
  await tenantOnboardSubmit(vendor).click();
  const page = await firstSignIn(browser, await takeCode(vendor));
  await page.setViewportSize({ width, height });
  await page.locator("html").evaluate((el) => { el.dataset.theme = "light"; });
  await go(page, "/org");
  await page.getByRole("link", { name: "법인 추가" }).click();
  await registerEntity(page, "자녀추가");
  return page;
}

async function furtherWorkplace(page: Page, name: string) {
  const sheet = page.getByRole("dialog", { name: "사업장 추가" });
  await sheet.getByLabel("사업장 이름").fill(name);
  await pickKind(sheet);
  await sheet.getByRole("radiogroup", { name: /^원천징수 신고/ }).getByText(/에서 함께 신고$/).click();
  await sheet.getByRole("radiogroup", { name: /^4대보험/ }).getByText("모두 성립 · 번호는 나중에", { exact: true }).click();
  await typeAddress(page, "소재지", "서울특별시 강남구 테헤란로 152", "06236");
  await sheet.getByRole("button", { name: "사업장 추가", exact: true }).click();
  await expect(sheet).toBeHidden();
}

for (const [width, height] of [[1280, 720], [1920, 1080]]) {
  for (const view of ["chart", "outline"] as const) {
    test(`${view} adds three siblings at every level by mouse at ${width}×${height}`, { tag: "@org" }, async ({ browser }) => {
      const page = await emptyEntity(browser, `add-many-${view}-${width}`, width, height);
      const entity = "주식회사 자녀추가";
      const outline = page.getByRole("tree", { name: "아웃라인", exact: true });
      const show = async () => {
        // Flush the observer's deferred records from the forms before auditing the chosen view.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))));
        await leaveScreen(page);
        await go(page, view === "outline" ? "/org?view=outline" : "/org");
        if (view === "outline") await expect(outline).toBeVisible();
      };
      for (let i = 1; i <= 3; i++) {
        await show();
        if (view === "outline") await outline.getByRole("treeitem", { name: new RegExp(`^${entity}`) }).getByRole("link", { name: "사업장 추가" }).click();
        else {
          await box(page, entity).click();
          if (i === 2) {
            await box(page, entity).getByRole("button", { name: `${entity} 더 보기` }).click();
            const menu = page.getByRole("menu", { name: `${entity} 더 보기` });
            await expect(menu.getByRole("menuitem").first()).toHaveText(/사업장 추가/);
            await menu.getByRole("menuitem", { name: /^사업장 추가/ }).click();
          } else if (i === 3) await page.locator(".page__head").getByRole("link", { name: "사업장 추가" }).click();
          else await page.getByRole("toolbar", { name: `${entity} 작업` }).getByRole("link", { name: "사업장 추가" }).click();
        }
        if (i === 1) await registerWorkplace(page, "자녀추가", "사업장1");
        else await furtherWorkplace(page, `사업장${i}`);
      }
      await show();
      if (view === "chart") await page.getByRole("button", { name: "부서 모두", exact: true }).click();
      const addChildren = async (parent: string, prefix: string) => {
        for (let i = 1; i <= 3; i++) {
          if (view === "outline") await outline.getByRole("treeitem", { name: new RegExp(`^${parent}\\s`) }).getByRole("button", { name: /부서 추가$/ }).click();
          else {
            await box(page, parent).click();
            if (i === 2) {
              await box(page, parent).getByRole("button", { name: `${parent} 더 보기` }).click();
              const menu = page.getByRole("menu", { name: `${parent} 더 보기` });
              await expect(menu.getByRole("menuitem").first()).toHaveText(/부서 추가/);
              await menu.getByRole("menuitem", { name: /부서 추가/ }).click();
            } else if (i === 3) {
              const panel = page.getByRole("complementary", { name: parent, exact: true });
              await expect(panel.getByRole("button", { name: /부서 추가$/ })).toHaveClass(/btn--primary/);
              await panel.getByRole("button", { name: /부서 추가$/ }).click();
            } else await page.getByRole("toolbar", { name: `${parent} 작업` }).getByRole("button", { name: /부서 추가$/ }).click();
          }
          const editor = view === "outline" ? outline.locator("[data-new]") : i === 3 ? page.getByRole("complementary", { name: parent, exact: true }) : page.locator('[data-s~="edit"]');
          const field = editor.getByRole("textbox", { name: `${parent} 아래 새 부서 이름` });
          if (i === 2) {
            await field.fill(`${prefix}1`);
            await expect(field).toHaveAttribute("aria-invalid", "true");
            await editor.getByRole("button", { name: "부서 추가", exact: true }).click();
            await expect(field).toHaveValue(`${prefix}1`);
            await expect(editor.getByRole("alert")).toBeVisible();
            await expect(view === "outline" ? outline.getByRole("treeitem", { name: new RegExp(`^${prefix}1\\s`) }) : box(page, `${prefix}1`)).toHaveCount(1);
          }
          await field.fill(`${prefix}${i}`);
          await editor.getByRole("button", { name: "부서 추가", exact: true }).click();
          await expect(field).toHaveValue("");
          await editor.getByRole("button", { name: "취소", exact: true }).click();
          const result = view === "outline" ? outline.getByRole("treeitem", { name: new RegExp(`^${prefix}${i}\\s`) }) : box(page, `${prefix}${i}`);
          await expect(result).toHaveCount(1);
        }
      };
      await addChildren("사업장1", "부서");
      await addChildren("부서1", "하위");
      if (view === "outline") {
        for (const name of ["사업장1", "사업장2", "사업장3", "부서1", "부서2", "부서3", "하위1", "하위2", "하위3"])
          await expect(outline.getByRole("treeitem", { name: new RegExp(`^${name}\\s`) })).toHaveCount(1);
      }
      await expectAccessible(page, `${view} add-many ${width}×${height}`);
      // The list has the same visible per-row add, even with existing children.
      await page.getByRole("button", { name: "목록", exact: true }).click();
      const grid = page.getByRole("grid", { name: "조직 구조 목록" });
      for (const [name, label] of [[entity, "사업장 추가"], ["사업장1", "부서 추가"], ["부서1", "하위 부서 추가"]] as const)
        await expect(grid.getByRole("row", { name: new RegExp(name) }).filter({ has: page.getByText(name, { exact: true }) }).getByRole(name === entity ? "link" : "button", { name: label, exact: true })).toBeVisible();
    });
  }
}

test("the chart keeps the dedicated keyboard add path", { tag: "@org" }, async ({ browser }) => {
  const page = await emptyEntity(browser, "add-many-keys");
  await go(page, "/org");
  await revealUnit(page, "주식회사 자녀추가");
  await page.keyboard.press("a");
  await registerWorkplace(page, "자녀추가", "사업장1");
  await go(page, "/org");
  for (const [parent, prefix] of [["사업장1", "부서"], ["부서1", "하위"]] as const) {
    await revealUnit(page, parent);
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: `${parent} 더 보기` });
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Enter");
    const field = page.getByRole("textbox", { name: `${parent} 아래 새 부서 이름` });
    for (let i = 1; i <= 3; i++) {
      await field.fill(`${prefix}${i}`);
      await field.press("Enter");
      await expect(box(page, `${prefix}${i}`)).toHaveCount(1);
      await expect(field).toBeEnabled();
    }
    await field.press("Escape");
  }
});
