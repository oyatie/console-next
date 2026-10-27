import { expect, type Browser, type Page } from "@playwright/test";
import { go, kstDate } from "../flows";
import { registerBranch, registerEntity, registerWorkplace, SECOND, setupCompany } from "../setup-flows";
import { addDepartments } from "../structure-flows";
import { openTenant } from "./tenant";
import { fillRegister, openRegistered, pressRegister, receiptOf, registerSheet } from "./register";

/** One admin, two legal entities with identically named workplaces, all created through the product. */
export async function peopleWorld(browser: Browser, slug: string) {
  const admin = await openTenant(browser, slug, "사람정밀");
  await setupCompany(admin, "사람정밀", "본사");
  const first = new URL(admin.url()).pathname.split("/").pop()!;
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["첫법인인사팀"]);
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "사람기술", false, undefined, SECOND);
  const second = new URL(admin.url()).pathname.split("/").pop()!;
  await admin.getByRole("tab", { name: /^사업장 \d/ }).click();
  await admin.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(admin, "사람기술", "본사");
  await registerBranch(admin, "사람기술", "분원", "0008512347");
  return { admin, first, second };
}

export async function registerAt(admin: Page, entity: string, name: string, number: string, pay = "3000000", phone = "010-1234-0024") {
  await go(admin, "/people/new");
  await fillRegister(admin, { name, number, hired: kstDate(-100), phone });
  const form = registerSheet(admin);
  await form.getByRole("radiogroup", { name: /^어디에 둡니까/ }).getByText("사업장 직속 · 부서 없이", { exact: true }).click();
  await form.getByRole("combobox", { name: "둘 곳" }).fill("본사");
  await admin.getByRole("option", { name: new RegExp(`${entity}.*본사`) }).click();
  await form.getByRole("textbox", { name: /^기본급/ }).fill(pay);
  await pressRegister(admin);
  const receipt = (await receiptOf(admin, name).textContent())!;
  await openRegistered(admin, name, number);
  await expect(admin.getByRole("heading", { level: 1 })).toContainText(name);
  return { id: new URL(admin.url()).pathname.split("/").pop()!, receipt };
}

export async function pickBulk(admin: Page, name: string) {
  await go(admin, "/people");
  await admin.getByRole("searchbox", { name: "이름 또는 사번" }).fill(name);
  await admin.getByRole("row", { name: new RegExp(name) }).locator("label", { has: admin.getByRole("checkbox") }).click();
  await admin.getByRole("button", { name: "선택한 1명 일괄 발령" }).click();
}
