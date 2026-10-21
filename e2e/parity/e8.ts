import { expect, type Page } from "@playwright/test";
import { go } from "../flows";
import { shot } from "./shot";

// E8 미배치 처리 on the parity world: the 「평택 1공장」 group placed (five to 생산2팀, one directly under 평택공장),
// then the 「아산」 group open with three people picked.
export async function captureE8(page: Page) {
  await go(page, "/people/unplaced");
  await expect(page.getByRole("heading", { name: "미배치 처리", level: 1 })).toBeVisible();
  const rows = page.getByRole("grid", { name: "미배치 처리" });
  const pick = async (n: number) => {
    // The drawn box (its label) takes the click; the checkbox input itself is visually hidden.
    for (let i = 0; i < n; i++) await rows.getByRole("row").nth(i + 1).locator("label", { has: page.getByRole("checkbox") }).click();
  };
  const groups = page.getByRole("complementary", { name: /원본 값별/ });
  await groups.getByRole("button", { name: /「평택 1공장」/ }).click();
  await pick(5);
  const find = page.getByRole("combobox", { name: "둘 부서" });
  await find.fill("생산2팀");
  await page.getByRole("option", { name: /생산2팀/ }).click();
  await page.getByRole("button", { name: "여기에 배치" }).click();
  await expect(page.getByRole("status").filter({ hasText: "배치 끝" })).toBeVisible();
  // Pressing the row (its 「따로 배치」 cell) picks that person alone.
  await rows.getByRole("row").nth(1).getByText("따로 배치").click();
  await page.getByRole("button", { name: "사업장 직속으로" }).click();
  await expect(groups.getByRole("button", { name: /「아산」/ })).toHaveAttribute("aria-pressed", "true");
  await pick(3);
  await shot(page, "E8-queue");
}
