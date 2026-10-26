// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.skip(process.env.E2E_SERVED === "1", "the component gallery is dev-only");

test("the gallery picker switches from list to search at the shared threshold", async ({ page }) => {
  await page.goto("/_gallery");
  const list = page.getByRole("combobox", { name: "직원 선택 (15명 목록)" });
  await list.selectOption("EMP00002");
  await expect(list).toHaveValue("EMP00002");
  const search = page.getByRole("combobox", { name: "직원 선택 (16명 검색)", exact: true });
  await search.fill("2번");
  await page.getByRole("option", { name: "2번 직원", exact: true }).click();
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await search.press("ArrowDown");
  await expect(page.getByRole("option", { name: "2번 직원", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("the 2,000-person picker announces the exact matching total once while open", async ({ page }) => {
  await page.goto("/_gallery");
  const search = page.getByRole("combobox", { name: "직원 선택 (2,000명 검색)", exact: true });
  const count = page.getByRole("status").filter({ hasText: /^2,000건$/ });
  await expect(count).toHaveCount(0);
  await search.fill(" ");
  await expect(count).toHaveCount(1);
  await expect(page.getByRole("option")).toHaveCount(50);
  const narrow = page.getByText("처음 50건만 표시합니다. 검색어를 더 입력해 범위를 좁히십시오.", { exact: true });
  await expect(narrow).toBeVisible();
  await search.fill("1");
  await expect(page.getByRole("status").filter({ hasText: /^1,271건$/ })).toHaveCount(1);
  await expect(page.getByRole("option")).toHaveCount(50);
  await expect(narrow).toBeVisible();
  await search.fill("EMP00100");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option", { name: "100번 직원 EMP00100", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^1건$/ })).toHaveCount(1);
  await expect(narrow).toHaveCount(0);
  await search.press("Tab");
  await expect(search).not.toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: /^1건$/ })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`ServerPicker states remain accessible in ${theme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/_gallery");
    const section = page.getByRole("heading", { name: "검색 선택기", exact: true }).locator("..");
    const readOnly = section.getByRole("combobox", { name: "직원 선택 (읽기 전용)", exact: true });
    await readOnly.focus();
    await expect(readOnly).toBeFocused();
    await expect(readOnly).toHaveAttribute("readonly", "");
    await readOnly.press("ArrowDown");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    const disabled = section.getByRole("combobox", { name: "직원 선택 (비활성화)", exact: true });
    await expect(disabled).toBeDisabled();
    await expect(disabled).toHaveAccessibleDescription("설정을 완료한 뒤 선택할 수 있습니다");
    const error = section.getByRole("combobox", { name: "직원 선택 (오류)", exact: true });
    await expect(error).toHaveAttribute("aria-invalid", "true");
    await expect(error).toHaveAccessibleDescription("서버가 요청을 처리하지 못했습니다.");
    const axe = await new AxeBuilder({ page }).include(".gallery__section:has(input[readonly])").analyze();
    expect(axe.violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    const screenshot = info.outputPath(`server-picker-${theme}.png`);
    await section.screenshot({ path: screenshot, animations: "disabled" });
    await info.attach(`server-picker-${theme}`, { path: screenshot, contentType: "image/png" });
    const loading = section.getByRole("combobox", { name: "직원 선택 (불러오는 중)", exact: true });
    await loading.fill("1");
    await expect(page.getByRole("status").filter({ hasText: /^찾는 중$/ })).toHaveCount(1);
  });
}
