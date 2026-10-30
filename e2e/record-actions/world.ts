import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { go } from "../flows";
import { registerAt } from "../helpers/entity";
import { openTenant } from "../helpers/tenant";
import { SETUP_DEPARTMENT, setupCompany, startOperations } from "../setup-flows";
import { addDepartments } from "../structure-flows";
import type { ReachPage, ReachStep } from "./reach";

// The record-actions world (docs/design/record-actions.md §6): a solo administrator's company, built through the product
// from an empty tenant, with one 사업장, optionally one 부서, one person and (seeded through the card) one emergency contact,
// one 학력 entry and one career; `live` takes it past 운영 시작 (change_mode GOVERNED).

export const NAMES = { workplace: "가람센터", dept: "영업팀", person: "김가람", contact: "배우자 홍••", school: "한빛고등학교", career: "다올기계 2019-01" } as const;
type World = { admin: Page; company: string; entityId: string; personId: string; person: string; live: boolean };

export async function soloWorld(browser: Browser, slug: string, company: string, live: boolean, o: { dept?: boolean; seed?: boolean } = {}): Promise<World> {
  const admin = await openTenant(browser, slug, company);
  await setupCompany(admin, company, NAMES.workplace);
  const entityId = new URL(admin.url()).pathname.split("/").pop()!;
  if (o.dept) {
    await go(admin, "/org");
    await addDepartments(admin, NAMES.workplace, [NAMES.dept]);
  }
  const personId = await registerAt(admin, NAMES.person, company, live ? SETUP_DEPARTMENT : NAMES.workplace);
  const w = { admin, company, entityId, personId, person: NAMES.person, live };
  if (o.seed) await seedCard(w);
  if (live) await startOperations(admin);
  return w;
}

/** The person's 인사카드, settled (its head and its personal section drawn). */
export async function openCard(w: World) {
  await go(w.admin, `/people/${w.personId}`);
  await expect(w.admin.getByRole("heading", { name: w.person, level: 1 })).toBeVisible();
  const personal = w.admin.getByRole("region", { name: "인적사항" });
  await expect(personal).toBeVisible();
  return personal;
}

/** Presses `act`, then waits for the re-read of the employee's `read` it causes (state, not a fixed time under load). */
export async function andReread(page: Page, read: string, act: () => Promise<unknown>) {
  const done = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith(read));
  await act();
  await done;
}

/** One emergency contact, one 학력 entry and one career, each added through its own 추가 on the card. */
async function seedCard(w: World) {
  const { admin } = w;
  const personal = await openCard(w);
  await admin.getByRole("button", { name: "비상연락처 추가" }).click();
  const sheet = admin.getByRole("dialog", { name: "비상연락처 추가" });
  await sheet.getByRole("textbox", { name: /^이름/ }).fill("홍길순");
  await sheet.getByRole("combobox", { name: /^관계/ }).selectOption({ label: "배우자" });
  await sheet.getByRole("textbox", { name: /^휴대전화/ }).fill("01022223333");
  await sheet.getByRole("checkbox").check();
  await andReread(admin, "/personal-facts", () => sheet.getByRole("button", { name: "인사 정보 1명 정정" }).click());
  await expect(personal.getByText(NAMES.contact)).toBeVisible();
  const records = admin.getByRole("region", { name: "이력" });
  await records.getByRole("button", { name: "학력 추가" }).click();
  const row = admin.getByRole("group", { name: "새 학력 줄" });
  await row.getByRole("textbox", { name: "학교" }).fill(NAMES.school);
  await row.getByRole("combobox", { name: "과정" }).selectOption("HIGH_SCHOOL");
  await row.getByRole("combobox", { name: "상태" }).selectOption("GRADUATED");
  await andReread(admin, "/records", () => row.getByRole("button", { name: "저장" }).click());
  await expect(records.getByText(NAMES.school)).toBeVisible();
  await row.getByRole("button", { name: "닫기" }).click();
  await records.getByRole("button", { name: "경력 추가" }).click();
  const career = admin.getByRole("group", { name: "새 경력 줄" });
  await career.getByRole("textbox", { name: "근무처" }).fill("다올기계");
  await career.getByLabel("시작일").fill("2019-01");
  await andReread(admin, "/register-facts", () => career.getByRole("button", { name: "저장" }).click());
  await expect(records.getByRole("row").filter({ hasText: "다올기계" })).toBeVisible();
  await career.getByRole("button", { name: "닫기" }).click();
}

/** The route of a registry page in this world. */
export const pageUrl = (w: World, p: ReachPage | "register") =>
  ({ people: "/people", card: `/people/${w.personId}`, entities: "/org/entities", entity: `/org/entities/${w.entityId}`, chart: "/org", register: "/people/new" })[p];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => NAMES[k as keyof typeof NAMES] ?? `{${k}}`);

/** The control one step names, by role and accessible name, inside the panel it names when it says so. */
export function control(page: Page, s: ReachStep): Locator {
  const name = fill(s.name);
  const scope = s.within ? page.getByRole("complementary", { name: fill(s.within) }) : page;
  if (s.role === "treeitem") return scope.getByRole("treeitem", { name: new RegExp(`^${esc(name)},`) }).first();
  if (s.any) return scope.getByRole(s.role, { name: new RegExp(`^(?:${name.split("|").map(esc).join("|")})$`) }).first();
  return scope.getByRole(s.role, { name: s.prefix ? new RegExp(`^${esc(name)}`) : name, exact: s.exact }).first();
}

/** Opens the page, presses every step but the last, and returns the last step's control (the action), not yet pressed. */
export async function walk(w: World, page: ReachPage | "register", via: readonly ReachStep[], timeout = 15_000) {
  // A menu or sheet the last walk left open is closed first (navigation is in-app, so it would cover this page).
  await w.admin.keyboard.press("Escape");
  await go(w.admin, pageUrl(w, page));
  for (const s of via.slice(0, -1)) await control(w.admin, s).click({ timeout });
  const last = control(w.admin, via.at(-1)!);
  await last.waitFor({ state: "visible", timeout });
  return last;
}
