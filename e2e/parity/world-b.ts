import { expect, type Browser, type Page } from "@playwright/test";
import { go } from "../flows";
import { openTenant } from "../helpers/tenant";
import { chooseWorkbook, payPeriod, people, rosterWorkbook, type Person } from "../helpers/import";
import { registerBranch, setupCompany } from "../setup-flows";
import { addDepartments } from "../structure-flows";

// The parity world for the employee action screens (EMP-B): one tenant built through the product from an empty
// database, shaped like the mockups' 새온그룹 at a smaller scale (stated per frame in the parity index).

export const ENTITY = "새온정밀";
export const SITE = "평택공장";
export const SITE2 = "아산공장";
/** [parent, kind, name] in creation order (setup phase: each applies at once). Every unit is a 부서 (MR-12: one
 * department kind; a 팀 is a 부서 under a 부서). */
const UNITS = [
  [SITE, "부서", "생산부"],
  [SITE, "부서", "경영지원부"],
  ["생산부", "팀", "생산1팀"],
  ["생산부", "팀", "생산2팀"],
  ["생산부", "팀", "생산3팀"],
  ["경영지원부", "팀", "인사팀"],
  [SITE2, "부서", "생산관리부"],
  ["생산관리부", "팀", "조립1팀"],
  ["생산관리부", "팀", "조립2팀"],
] as const;

/** [부서, 사업장] as HR wrote them. The last rows name no unit and a work place the tenant does not have, so those
 * people come in 미배치, grouped on the unplaced screen by that value. */
const PLACED = [["생산1팀", SITE], ["생산2팀", SITE], ["생산3팀", SITE], ["인사팀", SITE], ["조립1팀", SITE2], ["생산3팀", SITE]] as const;
const UNPLACED = ["평택 1공장", "평택 1공장", "아산", "평택 1공장", "아산", "생산", "평택 1공장", "아산", "본사", "평택 1공장", "아산", "생산", "본사", "평택 1공장", "아산", "생산", ""];

/** Numbers 10001… like the mockups' (주)새온정밀 range: `placed` people in units, then the unplaced ones. */
export function roster(placed: number, hired?: string): Person[] {
  const rows = people("X", placed + UNPLACED.length, ["-"], [SITE], ["정규직", "정규직", "계약직"]);
  return rows.map((p, i) => {
    const [unit, workplace] = i < placed ? PLACED[i % PLACED.length]! : ["미정", UNPLACED[i - placed]!];
    return { ...p, hired: hired ?? p.hired, number: String(10001 + i), unit, workplace };
  });
}

async function addUnits(admin: Page) {
  // The 부서 on the org chart (trunk's cs-chart; /setup/org redirects there).
  await go(admin, "/org");
  for (const [parent, , unit] of UNITS) await addDepartments(admin, parent, [unit]);
}

/** The roster through 가져오기: unknown 부서 values are left unanswered, so those people are 미배치. */
async function importRoster(admin: Page, rows: Person[]) {
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사명부_새온정밀.xlsx", await rosterWorkbook([{ name: `주식회사 ${ENTITY}`, rows }]));
  await payPeriod(admin);
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await expect(admin.locator('[aria-current="step"]')).toHaveText("열 확인", { timeout: 60_000 });
  const workplaceReading = admin.getByRole("button", { name: "법인 사업장으로 읽기" });
  if (await workplaceReading.isVisible()) await workplaceReading.click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click({ timeout: 30_000 });
  await expect(admin.locator('[aria-current="step"]')).toHaveText("모의 반영", { timeout: 60_000 });
  const unmatched = admin.getByRole("region", { name: /^찾지 못한 값/ });
  for (const v of ["정규직", "계약직"]) {
    const pick = unmatched.getByLabel(new RegExp(`${v}에 해당하는 고용 형태`));
    if (await pick.isVisible()) await pick.selectOption({ label: v });
  }
  const rerun = admin.getByRole("button", { name: "선택한 내용으로 다시 모의 반영" });
  if (await rerun.isVisible()) await rerun.click();
  const apply = admin.getByRole("button", { name: new RegExp(`^명부 반영: 신규 ${rows.length}명`) });
  await expect(apply).toBeEnabled({ timeout: 30_000 });
  await apply.click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
}

/** 새온그룹 in its setup phase: 법인, two 사업장, nine units, `count` imported people in units and 17 unplaced. */
export async function world(browser: Browser, count = 30, slug = "parityb", hired?: string) {
  const admin = await openTenant(browser, slug, "새온그룹");
  await setupCompany(admin, ENTITY, SITE);
  await registerBranch(admin, ENTITY, SITE2, "0008512347");
  await addUnits(admin);
  await importRoster(admin, roster(count, hired));
  return admin;
}
