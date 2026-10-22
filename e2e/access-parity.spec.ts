import { syntheticPhone } from "../scripts/check-fixture-ids.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { registerAt } from "./helpers/entity";
import { tenantSlugField, chooseRadio, firstSignIn, go, kstDate, stepUp, takeCode, unique, vendorPage } from "./flows";
import { registerEntity, registerWorkplace, SECOND, setupRail } from "./setup-flows";

// Mockup parity capture for the pilot roles screens (roles-ux M1–M6): every frame is reached through the UI from an empty
// database, in the mockups' data shape (two 법인, namesakes, accounts without a passkey) at 1440×900 ×2, light and dark.
// Runs only when E2E_PARITY_DIR names where the frames go; the clicks of the design's two click paths are counted against
// docs/design/access-model.md §9.4 on the way.
const DIR = process.env.E2E_PARITY_DIR;
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.fonts.ready);
  const html = page.locator("html");
  for (const theme of ["light", "dark"] as const) {
    await html.evaluate((el, t) => (el.dataset.theme = t), theme);
    await page.screenshot({ path: `${DIR}/${name}${theme === "dark" ? "--dark" : ""}.png` });
  }
  await html.evaluate((el) => (el.dataset.theme = "light"));
}

let phone = 0;
/** An employee through the register form (two 법인: the employer is chosen), then the account invite from their record. */
async function person(browser: Browser, admin: Page, name: string, entity: string, unit: string, signIn: boolean) {
  const id = await registerAt(admin, name, entity, unit, syntheticPhone(6000 + ++phone));
  await admin.getByRole("button", { name: "계정 초대" }).click();
  const sheet = admin.getByRole("dialog", { name: "계정 초대" });
  // No role and no 지점 (governance-01): the account holds nothing until a grant.
  await expect(sheet.getByRole("radio")).toHaveCount(0);
  await stepUp(sheet, "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  const code = await takeCode(admin);
  if (signIn) await firstSignIn(browser, code);
  return id;
}

/** A role from the grid (clicks counted): name, description, the cells named "<domain> <level>", saved. */
async function role(admin: Page, c: ReturnType<typeof clickCounter>, name: string, cells: string[], description = "") {
  await c.click(admin.getByRole("link", { name: "역할 추가" }).first());
  await admin.getByRole("textbox", { name: /^역할 이름/ }).fill(name);
  if (description) await admin.getByRole("textbox", { name: /^설명/ }).fill(description);
  for (const cell of cells) await c.click(admin.getByRole("button", { name: cell, exact: true }));
  await c.click(admin.getByRole("button", { name: "역할 추가" }));
  await expect(admin.getByRole("row", { name: new RegExp(name) })).toBeVisible();
}

const pickRole = async (c: Pick<ReturnType<typeof clickCounter>, "click">, page: Page, scope: Locator, name: string) => {
  await c.click(scope.getByRole("button", { name: / 역할$/ }).last());
  await c.click(page.getByRole("option", { name: new RegExp(`^${name}`) }));
};
const pickScope = async (c: Pick<ReturnType<typeof clickCounter>, "click">, page: Page, scope: Locator, node: RegExp, capture?: string) => {
  await c.click(scope.getByRole("button", { name: /범위 선택/ }).last());
  const view = page.getByRole("dialog", { name: "범위 선택" });
  await c.click(view.getByRole("treegrid", { name: "법인·사업장·부서" }).getByRole("row", { name: node }));
  if (capture) {
    await expect(view.getByText("포함됨").first()).toBeVisible();
    await expectAccessible(page, "scope sheet");
    await shot(page, capture);
  }
  await c.click(view.getByRole("button", { name: "이 범위로 설정" }));
};

test("roles parity capture: M1–M6 from an empty database", { tag: "@parity" }, async ({ browser }) => {
  test.skip(!DIR, "E2E_PARITY_DIR names the capture folder");
  test.setTimeout(900_000);
  mkdirSync(DIR!, { recursive: true });
  const c = clickCounter();

  // The group: (주)새온 with 본사, (주)새온물류 with 공장2, and the people the mockups name.
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("새온그룹");
  await tenantSlugField(v).fill(unique("saeon-roles"));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const admin = await firstSignIn(browser, await takeCode(v));
  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "새온");
  for (const [entity, place] of [["새온", "본사"], ["새온물류", "공장2"]] as const) {
    if (entity === "새온물류") {
      await go(admin, "/org/entities/new");
      await registerEntity(admin, entity, false, undefined, SECOND);
    }
    await admin.getByRole("button", { name: /^사업장 \d/ }).click();
    await admin.getByRole("link", { name: "사업장 추가" }).first().click();
    await registerWorkplace(admin, entity, place);
  }
  await person(browser, admin, "김인사", "새온", "본사", true);
  await person(browser, admin, "이노무", "새온물류", "공장2", true);
  const firstNamesake = await person(browser, admin, "김민수", "새온", "본사", false);
  const secondNamesake = await person(browser, admin, "김민수", "새온물류", "공장2", false);
  expect(secondNamesake, "namesakes at different employers keep separate records").not.toBe(firstNamesake);
  await person(browser, admin, "한서연", "새온", "본사", false);

  // M1 empty: no preset roles.
  await go(admin, "/");
  await admin.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "권한" }).click();
  await expect(admin.getByRole("heading", { name: "아직 역할이 없습니다" })).toBeVisible();
  await shot(admin, "M1-roles-empty");

  // Click path (1), §9.4: a role from scratch. The nav click above opened 권한.
  await role(admin, c, "인사 실무", ["인사기본 등록·수정", "발령 등록·수정", "근태·휴가 조회"], "직원 등록과 발령 처리");
  const path1 = c.done("create a role") + 1;
  expect(path1, "§9.4 (1) create a role: 9 clicks").toBeLessThanOrEqual(9);
  await role(admin, c, "인사 조회", ["인사기본 조회", "조직 조회"]);
  await role(admin, c, "권한 관리 보조", ["권한 관리 조회", "감사·접속기록 조회"]);
  c.done("two more roles");

  // M3 + M4: 김인사 gets two lines from go-live (the scope view captured while the second line is scoped).
  const opsName = (async () => (await (await admin.waitForResponse((r) => r.url().endsWith("/api/v1/access/ops"))).json()).display_name as string)();
  await admin.getByRole("navigation", { name: "권한 화면" }).getByRole("link", { name: /부여 현황/ }).click();
  const ops = await opsName;
  const pick = admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" });
  const open = async (name: string, nth = 0) => {
    await pick.fill(name);
    await c.click(admin.getByRole("option", { name: new RegExp(name) }).nth(nth));
    return admin.getByRole("dialog", { name: "권한 부여" });
  };
  let sheet = await open("김인사");
  await pickRole(c, admin, sheet, "인사 실무");
  await pickScope(c, admin, sheet, /주식회사 새온(?!물류)/);
  await c.click(sheet.getByRole("button", { name: /^1년/ }));
  await c.click(sheet.getByRole("button", { name: "역할 하나 더" }));
  await pickRole(c, admin, sheet, "인사 조회");
  await pickScope(c, admin, sheet, /주식회사 새온물류/, "M3-scope-picker");
  await c.click(sheet.getByRole("button", { name: "날짜 선택" }).last());
  await sheet.getByLabel("마지막 날 (날짜)").fill(kstDate(176));
  await chooseRadio(sheet, /^운영 시작과 함께/);
  await chooseRadio(sheet, /^업무 배정·변경/);
  await expect(sheet).toContainText("김인사님이 운영 시작부터 인사 실무");
  await expectAccessible(admin, "grant sheet (two lines)");
  await shot(admin, "M4-grant-person");
  await stepUp(sheet, "패스키로 확인하고 부여 2건 저장", admin.getByRole("status").filter({ hasText: "김인사님에게 부여 2건을 저장했습니다" }));
  await expect(admin.getByRole("link", { name: "요청 결과 보기", exact: true })).toHaveAttribute("href", /^\/requests\/[0-9a-f-]{36}$/);
  c.done("grant two lines");

  // Click path (2), §9.4: one person, one role over one 법인 until a date (from the 권한 nav, as the spec starts at its nav).
  await go(admin, "/");
  await c.click(admin.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "권한" }));
  await c.click(admin.getByRole("navigation", { name: "권한 화면" }).getByRole("link", { name: /부여 현황/ }));
  sheet = await open("이노무");
  await pickRole(c, admin, sheet, "인사 실무");
  await pickScope(c, admin, sheet, /공장2/);
  await c.click(sheet.getByRole("button", { name: "날짜 선택" }));
  await sheet.getByLabel("마지막 날 (날짜)").fill(kstDate(176));
  await chooseRadio(sheet, /^운영 시작과 함께/);
  await chooseRadio(sheet, /^업무 배정·변경/);
  await c.click(sheet.getByRole("button", { name: "패스키로 확인하고 부여 1건 저장" }));
  await expect(admin.getByRole("status").filter({ hasText: "이노무님에게 부여 1건을 저장했습니다" })).toBeVisible();
  const path2 = c.done("grant one role over one entity until a date") + 2; // + the when and reason radios
  expect(path2, "§9.4 (2) grant until a date: 12 clicks + passkey").toBeLessThanOrEqual(12);

  // M4 self: the ops account (holding everything already) is never offered in the picker (r3 SCOPE).
  await pick.fill(ops);
  await expect(admin.getByRole("option", { name: new RegExp(ops) })).toHaveCount(0);
  await pick.fill("");

  // M4 no passkey: 한서연 was invited and has not signed in.
  sheet = await open("한서연");
  await pickRole(c, admin, sheet, "인사 조회");
  await pickScope(c, admin, sheet, /주식회사 새온(?!물류)/);
  await c.click(sheet.getByRole("button", { name: /^6개월/ }));
  await chooseRadio(sheet, /^운영 시작과 함께/);
  await chooseRadio(sheet, /^업무 배정·변경/);
  await expect(sheet).toContainText("아직 패스키가 없어 로그인할 수 없습니다");
  await shot(admin, "M4-grant-nopasskey");
  await sheet.getByRole("button", { name: "취소" }).click();
  c.done("frames");

  // M1 list and the role editor of a held role (M2), then the delete dialog of a held role.
  await admin.getByRole("navigation", { name: "권한 화면" }).getByRole("link", { name: /역할/ }).click();
  await expect(admin.getByRole("row", { name: /인사 실무/ })).toContainText("2명");
  await expectAccessible(admin, "roles list");
  await shot(admin, "M1-roles-list");
  await admin.getByRole("link", { name: "인사 실무 역할 편집" }).click();
  await expect(admin.getByRole("complementary", { name: "이 역할을 가진 사람은" })).toContainText("김인사");
  await expectAccessible(admin, "role editor (held)");
  await shot(admin, "M2-role-edit");
  await admin.getByRole("link", { name: "역할 목록" }).click();
  await admin.getByRole("button", { name: "인사 실무 역할 삭제" }).click();
  const del = admin.getByRole("dialog", { name: "「인사 실무」 역할 삭제" });
  await expect(del).toContainText("이 역할을 2명이 가지고 있습니다");
  await chooseRadio(del, /^권한 정리/);
  await expectAccessible(admin, "role delete (held)");
  await shot(admin, "M1-roles-delete");
  await del.getByRole("button", { name: "취소" }).click();

  // M5: three people, one of whom already holds the role over that scope; the receipt refuses that one.
  await go(admin, "/access/grants/bulk");
  const table = admin.getByRole("region", { name: "부여할 사람" });
  // Rows are named by their name cell alone, so a namesake is found by its placement.
  for (const [name, place] of [["김민수", "본사"], ["김인사", "본사"], ["김민수", "공장2"]])
    await table.getByRole("row").filter({ hasText: name }).filter({ hasText: place }).getByRole("gridcell").first().click();
  const form = admin.getByRole("region", { name: "모두에게 줄 권한" });
  await pickRole(c, admin, form, "인사 조회");
  await pickScope(c, admin, form, /주식회사 새온물류/);
  await c.click(form.getByRole("button", { name: /^6개월/ }));
  await chooseRadio(form, /^운영 시작과 함께/);
  await chooseRadio(form, /^업무 배정·변경/);
  await expect(table).toContainText("동명이인");
  await expectAccessible(admin, "bulk pick");
  await shot(admin, "M5-bulk-pick");
  await form.getByRole("button", { name: "3명 미리보기" }).click();
  await expect(admin.getByText("1명이 거절되었습니다")).toBeVisible();
  await expect(admin.getByText("같은 역할이 같은 범위에 이미 있습니다")).toBeVisible();
  await expectAccessible(admin, "bulk receipt");
  await shot(admin, "M5-bulk-preview");
  await admin.getByRole("button", { name: "거절된 1명 제외하고 다시 미리보기" }).click();
  await stepUp(admin.locator("main"), "패스키로 확인하고 2명에게 부여", admin.getByRole("status").filter({ hasText: "부여 2건을 저장했습니다" }));
  c.done("bulk");

  // M6: 김인사's access, then the go-live readiness list.
  await admin.getByRole("navigation", { name: "권한 화면" }).getByRole("link", { name: /부여 현황/ }).click();
  await admin.getByRole("link", { name: /김인사/ }).first().click();
  await expect(admin.getByRole("heading", { name: "김인사님이 할 수 있는 일" })).toBeVisible();
  await expectAccessible(admin, "person access");
  await shot(admin, "M6-person-access");
  await admin.getByRole("navigation", { name: "권한 화면" }).getByRole("link", { name: "운영 시작 준비" }).click();
  await expect(admin.getByText("한서연님은 계정이 있지만 부여가 없습니다")).toBeVisible();
  await expectAccessible(admin, "readiness");
  await shot(admin, "M6-readiness");
  test.info().annotations.push({ type: "clicks", description: `§9.4 (1) ${path1} ≤ 9 · (2) ${path2} + P ≤ 12 + P` });
  writeFileSync(`${DIR}/clicks.json`, JSON.stringify({ createRole: path1, createRoleSpec: 9, grantUntilDate: path2, grantUntilDateSpec: 12 }));
});
