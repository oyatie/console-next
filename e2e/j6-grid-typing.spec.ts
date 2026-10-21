import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";

// regression (r3:records-01, r3:records-17): typing straight into a grid cell dropped the first word (a Korean IME's
// syllables, or Playwright's insertText, reached a cell that held no input) and the truncated value committed as a
// 정정; 성별 was a free-text input that took 「남」 + Enter as nothing.
const ADDRESS = "경기도 성남시 분당구 판교역로 235";

async function openGrid(page: Page, names: readonly string[]) {
  await go(page, "/people");
  const find = page.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("입력");
  await find.press("Enter");
  for (const name of names) await page.getByRole("row", { name: new RegExp(name) }).locator("label", { has: page.getByRole("checkbox") }).click();
  await page.getByRole("button", { name: `선택한 ${names.length}명 일괄 수정` }).click();
  await expect(page.getByRole("grid")).toBeVisible();
}

test("J6 grid typing: every typed character stays, an IME's first syllable included, and 성별 is picked from its options", { tag: ["@hr", "@regression"] }, async ({ browser, browserName }) => {
  const { admin } = await staffedTenant(browser, "j6type", "입력주식회사");
  const names = ["강입력", "남입력"];
  for (const [i, name] of names.entries()) await registerEmployee(admin, { name, number: `T-000${i + 1}`, unit: "인사부" });
  await openGrid(admin, names);

  // Row 1 주소: typed with no F2 first, then Enter. The editor and the cell hold every character.
  const address = admin.getByRole("gridcell", { name: "1행 주소" });
  await address.click();
  await admin.keyboard.type(ADDRESS);
  await expect(admin.getByRole("textbox", { name: "1행 주소" })).toHaveValue(ADDRESS);
  await admin.keyboard.press("Enter");
  await expect(address).toContainText(ADDRESS);

  // Row 2 주소 through an IME composition (Chromium's CDP IME; elsewhere the insertText path above covers it).
  const second = admin.getByRole("gridcell", { name: "2행 주소" });
  await second.click();
  if (browserName === "chromium") {
    const cdp = await admin.context().newCDPSession(admin);
    for (const step of ["ㅅ", "서", "설"]) await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
    await cdp.send("Input.insertText", { text: "서" });
    await admin.keyboard.type("울특별시 중구 세종대로 110");
  } else {
    await admin.keyboard.type("서울특별시 중구 세종대로 110");
  }
  await expect(admin.getByRole("textbox", { name: "2행 주소" })).toHaveValue("서울특별시 중구 세종대로 110");
  await admin.keyboard.press("Enter");
  await expect(second).toContainText("서울특별시 중구 세종대로 110");
  await expect(second).not.toHaveAttribute("aria-invalid", "true");

  // 성별 (records-17): an option control. Typing narrows it, Enter takes the option; ↑↓ walk it after F2.
  const sex = admin.getByRole("gridcell", { name: "1행 성별" });
  await sex.click();
  await admin.keyboard.type("남");
  await expect(admin.getByRole("listbox", { name: "1행 성별" }).getByRole("option", { name: "남" })).toBeVisible();
  await expectAccessible(admin, "J6 grid typing: 성별 options open");
  await admin.keyboard.press("Enter");
  await expect(sex).toContainText("남");
  await expect(sex).not.toHaveAttribute("aria-invalid", "true");
  const sex2 = admin.getByRole("gridcell", { name: "2행 성별" });
  await expect(sex2.getByRole("combobox")).toBeFocused();
  await admin.keyboard.press("F2");
  await admin.keyboard.press("ArrowDown");
  await admin.keyboard.press("Enter");
  await expect(sex2).not.toHaveText("");
  await expect(sex2).not.toHaveAttribute("aria-invalid", "true");

  // The check shows exactly what was typed; nothing was cut before it.
  await admin.getByRole("button", { name: /^확인으로/ }).click();
  const rows = admin.getByRole("table", { name: "줄별 보기" });
  await expect(rows.getByRole("row", { name: /강입력/ })).toContainText(ADDRESS);
  await expect(rows.getByRole("row", { name: /남입력/ })).toContainText("서울특별시 중구 세종대로 110");
  await expectAccessible(admin, "J6 grid typing: check");
});
