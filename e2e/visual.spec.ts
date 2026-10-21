import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";

// /_gallery is registered only in dev builds; the production shape (E2E_SERVED) has no gallery.
test.skip(process.env.E2E_SERVED === "1", "the component gallery is dev-only");

const gallery = (page: import("@playwright/test").Page) => page.getByRole("heading", { name: "컴포넌트 갤러리", level: 1 });

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
