// Shared by the UX-R2 ENDS close specs: a person hired in a unit at a 사업장, and the 사업장's close sheet.
import { expect, type Page } from "@playwright/test";
import { kstDate, registerEmployee } from "../flows";
import { sheet } from "../sheet";
import { openUnit } from "./structure";

/** Registers `name` in `unit`, hired `hired` (a past date unless given); the 직원 등록 sheet takes the 사업장 from the unit (`site` names it for the reader). */
export async function hire(admin: Page, name: string, unit: string, _site: string, hired = kstDate(-200)) {
  await registerEmployee(admin, { name, unit, hired });
}

export async function openClose(admin: Page, site: string) {
  const panel = await openUnit(admin, site);
  await panel.getByRole("button", { name: "사업장 폐쇄", exact: true }).click();
  const s = sheet(admin, `${site} 폐쇄`);
  await expect(s).toBeVisible();
  return s;
}

