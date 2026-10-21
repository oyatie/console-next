import { expect, type Locator, type Page } from "@playwright/test";
import { chooseRadio, go, stepUp } from "../flows";

/** A UI-created role and its scoped grant, with no preset or fixture account. */
export async function grantSetupRole(admin: Page, person: string, role: string, prepared: boolean) {
  await go(admin, "/access/roles/new");
  await admin.getByRole("textbox", { name: /^역할 이름/ }).fill(role);
  await admin.getByRole("button", { name: "인사기본 등록·수정" }).click();
  await admin.getByRole("button", { name: "역할 추가" }).click();
  await expect(admin).toHaveURL(/\/access\/roles$/);
  await go(admin, "/access/grants");
  await admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" }).fill(person);
  await admin.getByRole("option", { name: new RegExp(person) }).click();
  const sheet = admin.getByRole("dialog", { name: "권한 부여" });
  await expect(sheet.getByRole("group", { name: "현재 부여" })).toContainText("지금 가진 부여가 없습니다");
  await sheet.getByRole("button", { name: / 역할$/ }).click();
  await admin.getByRole("option", { name: new RegExp(`^${role}`) }).click();
  await sheet.getByRole("button", { name: /범위 선택/ }).click();
  const scope = admin.getByRole("dialog", { name: "범위 선택" });
  await scope.getByRole("treegrid", { name: "법인·사업장·부서" }).getByRole("row", { name: /^전체/ }).first().click();
  await scope.getByRole("button", { name: "이 범위로 설정" }).click();
  await expect(sheet.getByRole("group", { name: "현재 부여" })).toContainText("지금 가진 부여가 없습니다");
  await sheet.getByRole("button", { name: /^1년/ }).click();
  await chooseRadio(sheet, prepared ? /^운영 시작과 함께/ : /^설정 단계부터/);
  await chooseRadio(sheet, /^업무 배정·변경/);
  await stepUp(sheet, "패스키로 확인하고 부여 1건 저장", admin.getByRole("status").filter({ hasText: `${person}님에게 부여 1건을 저장했습니다` }));
}

/** Activate each focused control with the keyboard, including radios and checkbox labels. */
export async function keyboardActivate(control: Locator) {
  const role = await control.evaluate((el) => {
    const target = el.closest<HTMLElement>('button,a,input,[role="radio"],[role="button"],summary')
      ?? el.querySelector<HTMLElement>("input,button,a")
      ?? el.closest("label")?.querySelector<HTMLElement>("input");
    if (!target) throw new Error(`No keyboard control for ${el.textContent}`);
    target.focus();
    return target.getAttribute("role") ?? target.getAttribute("type");
  });
  await control.page().keyboard.press(role === "radio" || role === "checkbox" ? "Space" : "Enter");
}

/** Route button probe: every rendered action has a name and no fake href. */
export async function probeActions(page: Page) {
  const unnamed = await page.getByRole("main").locator("button, a").evaluateAll((els) => els.filter((el) =>
    !el.getAttribute("aria-label")?.trim() && !el.getAttribute("aria-labelledby") && !el.textContent?.trim() && !el.getAttribute("title"))
    .map((el) => el.outerHTML));
  expect(unnamed).toEqual([]);
  await expect(page.getByRole("main").locator('a[href="#"]')).toHaveCount(0);
}
