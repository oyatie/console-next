import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { registerEntity, registerWorkplace, SECOND, tenantInSetup } from "../setup-flows";
import { addDepartments } from "../structure-flows";
import { chooseWorkbook, payPeriod, people, protectedWorkbook, rosterWorkbook, type Person } from "../helpers/import";
import { gridRow, openItem, openRow, panel, queue, rowsGrid, settled } from "../helpers/import-queue";

// Roster import across two legal entities (BW-10, MR-7, decisions #18), through the UI only. A person's 사업장, and
// so their 법인, follows their 부서; the 사업장 column is read as the customer site and places nobody by itself
// unless it is exactly a 사업장's name.

const step = (page: Page) => page.locator('[aria-current="step"]');
const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });

test("a protected workbook is told apart before upload, with how to get a readable copy", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "importlock", "잠금상사");
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "급여대장_보안.xlsx", protectedWorkbook());
  await payPeriod(admin);
  await expect(admin.getByRole("alert").filter({ hasText: "암호나 문서 보안(DRM)이 걸린 파일입니다" })).toContainText("암호를 해제하거나");
  // The upload stays reachable and says why it does nothing.
  await expect(button(admin, "명부 미리보기")).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "import: protected workbook");
});

/** The second 법인 with its one 사업장, then a 부서 under each 사업장 (setup: each applies at once). */
async function twoEntities(admin: Page) {
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "누리", false, undefined, SECOND);
  await admin.getByRole("button", { name: /^사업장 \d/ }).click();
  await admin.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(admin, "누리", "누리 공장");
  // Setup: each 부서 typed on the chart under its 사업장 applies at once.
  await go(admin, "/org");
  await addDepartments(admin, "가람 본점", ["인사팀", "영업팀"]);
  await addDepartments(admin, "누리 공장", ["생산팀"]);
}

test("an HR admin imports 300 people across two legal entities, answers each unplaced value once, then settles a second load item by item", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "importtwo", "가람", false, "가람 본점");
  await twoEntities(admin);
  const g = people("GR", 180, ["인사팀", "영업팀"], ["가람 본점"], ["정규직", "계약직"]);
  // 누리's sheet: half its people are in a 부서 the tenant does not have (품질팀) and work at a customer site.
  const n = people("NR", 120, ["생산팀", "품질팀"], ["누리 공장", "A고객사 현장"]);

  // 1. First load: 300 new people.
  await go(admin, "/people/import");
  await expectAccessible(admin, "import: upload");
  await chooseWorkbook(admin, "인사명부_2026-10.xlsx", await rosterWorkbook([{ name: "가람", rows: g }, { name: "누리", rows: n }]));
  await payPeriod(admin);
  await button(admin, "명부 미리보기").click();
  await expect(step(admin)).toHaveText("열 확인", { timeout: 30_000 });
  const columns = admin.getByRole("table", { name: "열", exact: true });
  // r3:hire-38: what is stored says so (the sealed 주민등록번호, the 휴대전화), what is dropped says so (the account).
  for (const col of ["주민등록번호", "휴대전화"])
    await expect(columns.getByRole("row").filter({ hasText: col }).first()).toContainText("가려서 보관 · 원본에 남기지 않음");
  await expect(columns.getByRole("row").filter({ hasText: "급여계좌" }).first()).toContainText("저장하지 않음");
  await expect(columns.getByRole("row").filter({ hasText: "사업장" }).first()).toContainText("고객 현장으로 읽음");
  await expectAccessible(admin, "import: columns");
  await button(admin, "모의 반영 실행").click();

  await expect(step(admin)).toHaveText("모의 반영", { timeout: 30_000 });
  await expect(await gridRow(queue(admin), "품질팀")).toContainText("60");
  await expect(await gridRow(queue(admin), "A고객사 현장")).toContainText("60");
  await expect(await gridRow(queue(admin), "계약직")).toContainText("90");
  // Unplaced values never block: those people would come in 미배치. Each is answered once for every row, and each
  // answer runs the dry run again at once.
  await expect(button(admin, "명부 반영: 신규 300명 · 갱신 0명")).toBeEnabled();
  await openItem(admin, "품질팀");
  await panel(admin).getByLabel(/품질팀에 연결할 부서/).selectOption({ label: "미배치로 둡니다" });
  await openItem(admin, "A고객사 현장");
  await panel(admin).getByRole("radiogroup", { name: /A고객사 현장/ }).getByText("사업장이 아닌 고객 현장입니다").click();
  for (const type of ["정규직", "계약직"]) {
    await openItem(admin, type);
    await panel(admin).getByLabel(new RegExp(`${type}에 해당하는 고용 형태`)).selectOption({ label: type });
  }
  await settled(admin);
  await expectAccessible(admin, "import: dry run with its 확인 필요 queue");
  const apply1 = button(admin, "명부 반영: 신규 300명 · 갱신 0명");
  await expect(apply1).toBeEnabled();
  // Each new person's 법인 · 사업장 follows their 부서 (decisions #18).
  await expect(await gridRow(rowsGrid(admin), g[0]!.number)).toContainText("가람 본점");
  await expect(await gridRow(rowsGrid(admin), g[0]!.number)).toContainText("신규 등록");
  await apply1.click();
  // 300 people with their placement, profile and ledger rows: allow the write its time.
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByText("신규 300명 · 갱신 0명 · 건너뜀 0명")).toBeVisible();
  await expectAccessible(admin, "import: applied");

  // The record reads the placement back by id (Enter on an exact 사번 opens that person).
  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill(n[0]!.number);
  await find.press("Enter");
  await expect(admin.getByRole("heading", { name: new RegExp(n[0]!.name), level: 1 })).toBeVisible();
  // The head's 소속, not the placement history's same links.
  const head = admin.getByRole("group", { name: "소속", exact: true });
  await expect(head.getByRole("link", { name: "주식회사 누리" })).toBeVisible();
  await expect(head.getByRole("link", { name: "누리 공장" })).toBeVisible();

  // 2. Second load of the same roster, as HR edits it: a promotion (an update), a 부서 move (never written by import:
  //    it goes to 발령), a renamed person (refused), a hire date no calendar has (refused), and a row without a 사번
  //    that carries the 주민등록번호 of a person on file (found by it, never by the name).
  const g2: Person[] = g.map((p) => ({ ...p }));
  g2[0]!.position = "부장";
  g2[1]!.unit = g2[1]!.unit === "인사팀" ? "영업팀" : "인사팀";
  g2[2]!.name = `${g2[2]!.name}수`;
  g2[3]!.hired = "2026-13-40";
  // The twin is 누리's sixth person, whose own row this second file leaves out (a row per person, as on file).
  const twin: Person = { ...n[5]!, number: "" };
  const n2 = n.filter((_, i) => i !== 5);
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사명부_2026-10_수정.xlsx", await rosterWorkbook([{ name: "가람", rows: [...g2, twin] }, { name: "누리", rows: n2 }]));
  await payPeriod(admin);
  await button(admin, "명부 미리보기").click();
  await button(admin, "모의 반영 실행").click();
  await expect(step(admin)).toHaveText("모의 반영", { timeout: 30_000 });
  await expect(await openRow(admin, g2[0]!.number)).toContainText("직위: 사원 → 부장");
  await expect(await openRow(admin, g2[1]!.number)).toContainText("발령으로 처리합니다");
  await expect(await openRow(admin, g2[2]!.number)).toContainText("같은 사번의 직원과 다릅니다");
  await expect(await openRow(admin, g2[3]!.number)).toContainText("날짜로 읽을 수 없습니다");
  // The twin (no 사번) is found by the 주민등록번호 on file: no question is asked about it (any-layout.spec reads the row).
  await expect(button(admin, /^명부 반영/)).toHaveAttribute("aria-disabled", "true");
  await expect(admin.getByText(/반영을 막는 확인 필요 항목 2개를 처리하십시오/)).toBeVisible();
  await expectAccessible(admin, "import: second dry run, items that block");

  for (const [what, why] of [["같은 사번의 직원과 다릅니다", "중복"], ["날짜로 읽을 수 없습니다", "형식 오류"]] as const) {
    await openItem(admin, what);
    const exclude = panel(admin).getByRole("button", { name: "이번에는 제외" });
    if (await exclude.isVisible()) await exclude.click();
    await panel(admin).getByRole("radiogroup", { name: /제외하는 이유/ }).getByText(why, { exact: true }).click();
    await panel(admin).getByRole("button", { name: "이 행을 제외하고 다시 모의 반영" }).click();
    await settled(admin);
  }
  const apply2 = admin.getByRole("button", { name: /^명부 반영: 신규 0명 · 갱신 \d+명$/ });
  await expect(apply2).toBeEnabled();
  await apply2.click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
});

// BW-10 item 9: an applied run is rolled back within 7 days by a second person. No backend serves the run record or
// the rollback yet (backend-followups #21 (a)); the panel is built (ui/rollback-panel.tsx) and not mounted.
test.fixme("a second person rolls an applied import back within 7 days (BW-10 item 9, not served)", async () => {});
