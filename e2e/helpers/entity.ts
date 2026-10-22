import { expect, type Page } from "@playwright/test";
import { fmtDate } from "@console/i18n/format";
import { go, kstDate, option } from "../flows";
import { registerWorkplace } from "../setup-flows";
import { fillRegister, openRegistered, pressRegister, receiptOf } from "./register";
import { fillDate } from "../sheet";

/**
 * On the 법인 record: opens 고치기 on one fact and chooses 변경 from `from` (today when omitted) or 정정, returning
 * the sheet with its new-value editor open. Nothing is preselected in the sheet, so every choice is pressed here.
 */
export async function reviseFact(page: Page, field: string, verb: "rev" | "cor", from?: string) {
  await page.getByRole("button", { name: `${field} 수정`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: `${field} 수정` });
  const what = sheet.getByRole("radiogroup", { name: /무엇을 기록합니까/ });
  if (verb === "cor") {
    await what.getByText("처음부터 잘못 적었습니다 · 정정", { exact: true }).click();
    return sheet;
  }
  await what.getByText(/바뀌었습니다 · 변경$/).click();
  if (!from || from === kstDate()) await option(page, "언제부터 바뀝니까", `오늘 (${fmtDate(kstDate())})`).click();
  else {
    await option(page, "언제부터 바뀝니까", "직접 입력").click();
    await fillDate(sheet, from, "적용일");
  }
  return sheet;
}

/** The entity's first workplace, from its page: its own certificate's place, name prefilled (as multi-entity.spec). */
export async function firstWorkplace(admin: Page, entity: string, name: string) {
  await admin.getByRole("button", { name: /^사업장 \d/ }).click();
  await admin.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(admin, entity, name);
}

/**
 * Registers `name` at `unit` of 주식회사 `entity` through the 직원 등록 sheet (two entities: the place is searched by its
 * path and the employer follows the place, never a default); lands on their record and returns their id.
 */
export async function registerAt(admin: Page, name: string, entity: string, unit: string, phone?: string) {
  await go(admin, "/people/new");
  await fillRegister(admin, { name, unit, hired: kstDate(), phone });
  const record = receiptOf(admin, name).getByRole("link", { name: "인사카드 열기" });
  const previous = await record.count() ? await record.getAttribute("href") : null;
  const registered = admin.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/employees");
  await pressRegister(admin);
  expect((await registered).status(), "employee registration refused").toBe(201);
  await expect(receiptOf(admin, name)).toBeVisible();
  // A namesake's old receipt remains visible until this registration returns.
  if (previous) await expect(record).not.toHaveAttribute("href", previous);
  await openRegistered(admin, name);
  await expect(admin.getByRole("heading", { name: new RegExp(name), level: 1 })).toBeVisible();
  await expect(admin.getByRole("group", { name: "소속", exact: true }).getByRole("link", { name: `주식회사 ${entity}` })).toBeVisible(); // the head's 소속, not the placement history's same link
  return new URL(admin.url()).pathname.split("/").pop()!;
}

/** The edit sheet of one of the record's name rows (법인명, 약칭, 영문명, 상호). */
const nameDialog = (p: Page, label: string) => p.getByRole("dialog", { name: `${label} 수정` });
/** Opens that row's edit, choosing 정정 when the sheet asks what is recorded; returns the sheet. */
export async function editName(p: Page, label: string) {
  await p.getByRole("button", { name: `${label} 수정`, exact: true }).click();
  const d = nameDialog(p, label);
  const cor = d.getByRole("radio", { name: "처음부터 잘못 적었습니다 · 정정" });
  if (await cor.count()) await option(p, "무엇을 기록합니까", "처음부터 잘못 적었습니다 · 정정").click();
  return d;
}
async function saveName(p: Page, label: string) {
  const d = nameDialog(p, label);
  const saved = p.waitForResponse((r) => r.request().method() === "PUT" && /^\/api\/v1\/legal-entities\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname));
  await d.getByRole("button", { name: "정정 기록", exact: true }).click();
  expect((await saved).status(), "entity name revision refused").toBe(200);
  await expect(d).toBeHidden();
}
/** Corrects one name row of the open 법인 record to `value`. */
export async function setName(p: Page, label: string, value: string) {
  const d = await editName(p, label);
  await d.getByRole("textbox", { name: label }).fill(value);
  await saveName(p, label);
}
