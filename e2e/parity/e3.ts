import { expect, type Locator, type Page } from "@playwright/test";
import { go } from "../flows";
import { shot } from "./shot";

// E3 registration frames, driven through the UI on the parity world (world-b.ts).

export const sheet = (page: Page) => page.getByRole("dialog", { name: "직원 등록" });

/** Opens the sheet from the roster's own button, as a person does. */
export async function openRegister(page: Page) {
  await go(page, "/people");
  await page.getByRole("link", { name: "직원 등록", exact: true }).click();
  await expect(sheet(page)).toBeVisible();
}

/** Picks a place in the sheet's search box by typing part of its name. */
export async function pickPlace(page: Page, text: string) {
  const box = sheet(page).getByRole("combobox", { name: "둘 곳" });
  await box.fill(text);
  await page.getByRole("option", { name: new RegExp(text) }).first().click();
}

const chip = (scope: Locator, group: string | RegExp, name: string | RegExp) => scope.getByRole("radiogroup", { name: group }).getByText(name, { exact: typeof name === "string" });

/** The person the mockup registers: 임하람, 1999-11-03, 생산1팀, next Monday, 정규직 (+ the fields the server still needs). */
export async function fillRegister(page: Page, who = { name: "임하람", birth: "1999-11-03", unit: "생산1팀" }) {
  const s = sheet(page);
  await s.getByLabel("이름").fill(who.name);
  await s.getByRole("textbox", { name: /^생년월일/ }).fill(who.birth);
  await pickPlace(page, who.unit);
  await s.getByRole("button", { name: /^다음 주 월요일/ }).click();
  await chip(s, /^고용형태/, "정규직").click();
  await s.getByRole("textbox", { name: /^휴대전화/ }).fill(`010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`);
  await s.getByRole("textbox", { name: /^직위/ }).fill("사원");
  await s.getByRole("textbox", { name: /^기본급/ }).fill("3000000");
}

export async function captureE3(page: Page) {
  await openRegister(page);
  await shot(page, "E3-register-initial");
  await fillRegister(page);
  await expect(sheet(page)).toContainText("입사 예정");
  await shot(page, "E3-register");
  // Close without saving; the error frame: a birth date typed, a start date no calendar has, nothing else.
  await sheet(page).getByRole("button", { name: "닫기", exact: true }).click();
  await openRegister(page);
  const s = sheet(page);
  await s.getByRole("textbox", { name: /^생년월일/ }).fill("1999-11-03");
  await s.getByRole("button", { name: "직접", exact: true }).click();
  await s.getByRole("textbox", { name: /^입사일/ }).fill("2026-13-01");
  await s.getByRole("button", { name: /^등록하고 다음 사람/ }).click();
  await expect(s.getByRole("alert").first()).toContainText("수정해야 등록됩니다");
  await shot(page, "E3-register-error");
  await s.getByRole("button", { name: "닫기", exact: true }).click();
  // The duplicate: 김민서 registered once, then typed again with the same name and birth date.
  for (const round of [0, 1]) {
    await openRegister(page);
    await fillRegister(page, { name: "김민서", birth: "1998-04-17", unit: "생산2팀" });
    await sheet(page).getByRole("button", { name: round ? /^등록하고 다음 사람/ : /^등록하고 닫기/ }).click();
    if (!round) await expect(sheet(page)).toBeHidden();
  }
  await expect(sheet(page).getByText(/같은 사람일 수 있습니다/)).toBeVisible();
  await shot(page, "E3-register-dup");
  await sheet(page).getByRole("button", { name: "닫기", exact: true }).click();
}

const runCell = (page: Page, n: number, field: string) => page.getByRole("textbox", { name: `${n}번째 사람 ${field}` });

/**
 * E3-run: 연속 등록 from the sheet's link — the first person typed in full in 조립1팀, the carry chips switched on, then
 * per person only the name, the birth date and the phone the server still requires (EMP-UI 1), each saved with ⌘↵.
 * Seven rows fold the first two; the frame is the eighth person half typed.
 */
export async function captureE3Run(page: Page) {
  await openRegister(page);
  await sheet(page).getByRole("link", { name: "연속 등록" }).click();
  await expect(page.getByRole("heading", { name: "연속 등록", level: 1 })).toBeVisible();
  const people = [["하예솔", "1990-10-12"], ["서정우", "1991-03-13"], ["문채이", "1992-08-14"], ["남궁별", "1993-01-15"], ["표건우", "1994-06-16"], ["윤다온", "1995-02-17"], ["백시아", "1996-09-18"]] as const;
  for (const [i, [name, birth]] of people.entries()) {
    const n = i + 1;
    await runCell(page, n, "이름").fill(name);
    await runCell(page, n, "생년월일").fill(birth);
    await runCell(page, n, "휴대전화").fill(`0102300${String(1000 + n)}`);
    if (n === 1) {
      await page.getByRole("combobox", { name: "1번째 사람 고용형태" }).selectOption({ label: "정규직" });
      await page.getByRole("combobox", { name: "1번째 사람 둘 곳" }).pressSequentially("조립1");
      await page.getByRole("option", { name: /조립1팀/ }).first().click();
      await runCell(page, 1, "입사일").fill("2026-10-19");
      await runCell(page, 1, "직위").fill("사원");
      await runCell(page, 1, "기본급").fill("2800000");
      const carry = page.getByRole("group", { name: /^다음 사람에게도 같은 값 쓰기/ });
      for (const k of [/^둘 곳/, /^입사일/, /^고용형태/, /^직위/, /^기본급/]) await carry.getByRole("button", { name: k }).click();
    }
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByRole("row").filter({ hasText: name })).toContainText("E-");
  }
  await runCell(page, 8, "이름").fill("조하율");
  await shot(page, "E3-run");
}
