import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import AxeBuilder from "@axe-core/playwright";

// /_gallery is registered only in dev builds; the production shape (E2E_SERVED) has no gallery.
test.skip(process.env.E2E_SERVED === "1", "the component gallery is dev-only");

const gallery = (page: import("@playwright/test").Page) => page.getByRole("heading", { name: "컴포넌트 갤러리", level: 1 });

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`top-bar parts at ${width}px, ${theme}`, { tag: ["@visual", "@regression"] }, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/_gallery");
      // The dock-sheet gallery starts open and becomes modal on phones.
      if (width === 390) {
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
      const section = page.getByRole("heading", { name: "상단 표시줄", exact: true }).locator("..");
      await section.scrollIntoViewIfNeeded();
      await expect(section.getByRole("link", { name: "설정 단계", exact: true })).toHaveCount(1);
      const name = "남궁가나다라마바사아자차카타파하 선임 인사총무담당";
      const trigger = section.getByRole("button", { name, exact: true }).first();
      await expect(trigger).toHaveAccessibleName(name);
      await expect(trigger.getByText(name, { exact: true })).toBeVisible({ visible: width > 640 });
      expect(await section.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      await trigger.press("Enter");
      const menu = page.getByRole("menu", { name, exact: true });
      await expect(menu.getByRole("menuitem")).toHaveText(["내 계정", "언어", "화면 테마", "로그아웃"]);
      await expect(page.getByRole("menuitem", { name: "내 계정", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "언어", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("menuitemradio", { name: "한국어", exact: true })).toHaveAttribute("aria-checked", "true");
      // Both submenus open inside the viewport (they once opened off the left edge at 390 px).
      const onScreen = async (label: string) => {
        const box = await page.getByRole("menu", { name: label, exact: true }).boundingBox();
        expect(box, label).not.toBeNull();
        expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(width);
      };
      await onScreen("언어");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menuitem", { name: "언어", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("menu", { name: "화면 테마", exact: true })).toBeVisible();
      await onScreen("화면 테마");
      const axe = await new AxeBuilder({ page }).include(".gallery__section:has(#gallery-account-SETUP)").include('[role="menu"]').analyze();
      expect(axe.violations).toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await info.attach(`top-bar-${width}-${theme}`, { body: await section.screenshot({ animations: "disabled" }), contentType: "image/png" });
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 1024, 390]) {
    test(`gallery at ${width}px, ${theme}`, { tag: "@visual" }, async ({ page }) => {
      // The theme follows the OS until the user picks one, so the colour scheme selects it.
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/_gallery");
      await expect(gallery(page)).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.evaluate(() => document.fonts.ready);
      // Full-page capture lays out offscreen content; warm it once before comparing its stable height.
      await page.screenshot({ fullPage: true, animations: "disabled" });
      await expect(page).toHaveScreenshot(`gallery-${width}-${theme}.png`, { fullPage: true, animations: "disabled", maxDiffPixelRatio: 0.002 });
    });
  }
}

test("gallery components pass axe, and its controls work", { tag: ["@smoke", "@visual"] }, async ({ page }) => {
  // Tall enough that nothing scrolls: React Aria closes the picker's popover on page scroll.
  await page.setViewportSize({ width: 1280, height: 4000 });
  await page.goto("/_gallery");
  await expect(gallery(page)).toBeVisible();
  await expectAccessible(page, "gallery");

  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.getByText("다시 불러온 데이터입니다.")).toBeVisible();

  const picker = page.getByRole("combobox", { name: "조직" });
  await picker.fill("태스크");
  await page.getByRole("option", { name: /태스크포스팀/ }).click();
  await expect(page.getByRole("combobox", { name: "조직" })).toHaveValue(/태스크포스팀/);

  await expect(page.getByRole("button", { name: "입력 내용 확인" })).toBeDisabled();
  await page.getByLabel("입력한 내용을 확인했습니다").check();
  await page.getByRole("button", { name: "입력 내용 확인" }).click();
  await expect(page.getByRole("status").filter({ hasText: "입력을 확인했습니다." })).toBeVisible();

  // View tabs (WAI-ARIA APG): arrows move and select, Home / End jump, the panel follows the selection.
  const views = page.getByRole("tablist", { name: "보기" });
  await views.getByRole("tab", { name: "조직도" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(views.getByRole("tab", { name: /목록/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: /목록/ })).toContainText("목록 보기입니다.");
  await page.keyboard.press("End");
  await expect(views.getByRole("tab", { name: /아웃라인/ })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(views.getByRole("tab", { name: "조직도" })).toHaveAttribute("aria-selected", "true");
  // Route tabs are links in a named nav, the current one marked; an icon-only button is named and titled by its label.
  await expect(page.getByRole("navigation", { name: "권한 화면" }).getByRole("link", { name: /역할/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "이 행 더 보기", exact: true })).toHaveAttribute("title", "이 행 더 보기");
  await expect(page.getByRole("navigation", { name: "보고 있는 위치" }).getByText("(주)새온정밀")).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "대화상자 열기" }).click();
  await expect(page.getByRole("dialog", { name: "대화상자 예시" })).toBeVisible();
  await expectAccessible(page, "gallery dialog");
  await page.getByRole("dialog").getByRole("button", { name: "돌아가기" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("button", { name: "어두운 화면으로 전환" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
