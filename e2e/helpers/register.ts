import { expect, type Locator, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";

// The 직원 등록 sheet (spec employee-ux E3), driven as a person does: typing is free, picks are clicks.

type C = { click: (l: Locator) => Promise<void>; select?: (l: Locator, v: string) => Promise<void> };
const plain: C = { click: (l) => l.click() };

/** The registration sheet, opened over the roster. */
export const registerSheet = (page: Page) => page.getByRole("dialog", { name: "직원 등록" });

export type Person = { name: string; number?: string; unit?: string; workplace?: string; hired: string; type?: "정규직" | "계약직"; contractEnd?: string; phone?: string };

/**
 * Fills the open sheet: name, a typed 사번 when given, the place (searched by `unit`; left alone when the sheet opened
 * with one chosen), the start date typed into its visible field, the type, and the fields the server still needs.
 */
export async function fillRegister(page: Page, p: Person, c: C = plain) {
  const s = registerSheet(page);
  await s.getByRole("textbox", { name: /^이름/ }).fill(p.name);
  if (p.number) {
    await c.click(s.getByRole("radiogroup", { name: /^사번/ }).getByText("직접 입력", { exact: true }));
    await s.getByLabel("사번 직접 입력").fill(p.number);
  }
  if (p.unit) {
    await s.getByRole("combobox", { name: "둘 곳" }).fill(p.unit);
    await c.click(page.getByRole("option", { name: new RegExp(p.unit) }).first());
  }
  // A unit not under a registered workplace asks which one (the org chart made it before the workplace was registered).
  if (p.workplace) await c.click(s.getByRole("radiogroup", { name: /^어느 사업장 소속입니까/ }).getByText(new RegExp(p.workplace)));
  await s.getByRole("textbox", { name: /^입사일/ }).fill(p.hired);
  await s.getByRole("textbox", { name: /^입사일/ }).blur();
  await loadCatalog("ko");
  // The type keeps its label in both styles: Classic draws its options as chips, Console as a list box.
  const type = p.type ?? (p.contractEnd ? "계약직" : "정규직");
  const types = s.getByRole("radiogroup", { name: t("register.type") }).or(s.getByRole("combobox", { name: t("register.type") }));
  if (await types.evaluate(field => field instanceof HTMLSelectElement)) await (c.select ?? ((l, v) => l.selectOption(v).then(() => undefined)))(types, type);
  else await c.click(types.getByText(type, { exact: true }));
  if (p.contractEnd) {
    await s.getByLabel(/^계약 종료일/).fill(p.contractEnd);
    await s.getByLabel(/^계약 종료일/).blur();
  }
  await s.getByRole("textbox", { name: /^휴대전화/ }).fill(p.phone ?? "010-1234-0001");
  await s.getByRole("textbox", { name: /^직위/ }).fill("사원");
  await s.getByRole("textbox", { name: /^기본급/ }).fill("3000000");
}

/** The sheet's commit for one person, or with `next` the one that keeps the sheet open for the next person. */
export async function pressRegister(page: Page, next = false, c: C = plain) {
  await loadCatalog("ko");
  const label = t("composer.commit.count", { action: t("composer.action.registration"), count: 1, unit: t("composer.unit.people"), verb: t("composer.verb.apply") });
  // The plain commit's name is part of the next-person commit's, so it is matched whole.
  await c.click(registerSheet(page).getByRole("button", next ? { name: t("composer.commit.next", { label }) } : { name: label, exact: true }));
}

/** The receipt a registration leaves (in the sheet while it stays open, on the roster once it closes). */
export const receiptOf = (page: Page, name: string) => page.getByRole("status").filter({ hasText: new RegExp(`${name}.* 등록했습니다 · 사번 `) }).first();

/**
 * Opens the record of the person a receipt names, through the receipt's own link (a person starting later is not on the default
 * roster, so a 사번 search there finds nobody), and checks it is the 사번 the receipt shows.
 */
export async function openRegistered(page: Page, name: string, number?: string) {
  const receipt = receiptOf(page, name);
  const n = number ?? (await receipt.textContent())!.match(/사번 ([\w-]+)/)![1]!;
  await receipt.getByRole("link", { name: "인사카드 열기" }).click();
  // The record's head (the card shows the 사번 beside the name, outside the h1).
  await expect(page.getByRole("heading", { level: 1 }).locator("..")).toContainText(n, { timeout: 15_000 });
}
