import { expect, test, type Page } from "@playwright/test";
import { go } from "../flows";
import { parity, shot, VIEW } from "./shot";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook, payPeriod } from "../helpers/import";
import { crew, empty, notes, plain, rrn, titled, workbook, type Row } from "../helpers/import-layouts";
import { gridRow, openItem, openRow, panel, queue, rowsGrid, settled } from "../helpers/import-queue";
import { addDepartments } from "../structure-flows";

// IMPORT-2 (decisions #25, #26) from an empty database, through the UI only: a workbook as an HR team keeps it (a
// titled sheet with synonym labels and 재직/휴직 columns, a site crew sheet no catalog can read, a notes sheet and an
// empty one), the operator's column mapping, the counted 확인 필요 queue settled item by item, then a second file
// that the company's memory and the 주민등록번호 match, and a 동명이인 told apart by 사번·소속·masked 생년월일.
// identifiers.spec.ts covers what follows: 사번 변경, the masked number revealed with a reason, SETUP renumbering.

const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });
const step = (page: Page) => page.locator('[aria-current="step"]');

const HQ: Row[] = [
  { number: "HJ-0101", name: "김민준", unit: "인사팀", position: "과장", hired: "2015-03-02", birth: "1985-04-12", status: "재직", rrn: rrn("1985-04-12", 1, 101) },
  { number: "HJ-0102", name: "김민준", unit: "생산팀", position: "사원", hired: "2019-07-01", birth: "1992-11-30", status: "재직", rrn: rrn("1992-11-30", 1, 102) },
  { number: "HJ-0103", name: "이서연", unit: "인사팀", position: "대리", hired: "2018-01-15", birth: "1990-02-03", status: "휴직", leaveType: "육아휴직", leaveStart: "2026-03-01", leaveReturn: "2027-02-28", rrn: rrn("1990-02-03", 2, 103) },
  { number: "HJ-0104", name: "박도윤", unit: "생산팀", position: "사원", hired: "2020-05-11", birth: "1993-06-07", status: "휴직", leaveType: "질병휴직", leaveStart: "2026-09-01", rrn: rrn("1993-06-07", 1, 104) },
  { number: "HJ-0105", name: "최지우", unit: "생산팀", position: "사원", hired: "2021-08-23", birth: "1995-01-19", status: "장기휴직", leaveStart: "2026-08-01", rrn: rrn("1995-01-19", 2, 105) },
  { number: "HJ-0106", name: "정하준", unit: "품질팀", position: "사원", hired: "2022-02-14", birth: "1996-12-25", status: "재직", rrn: rrn("1996-12-25", 1, 106) },
];
const CREW: Row[] = [{ name: "강시우", hired: "2026-09-01" }, { name: "윤하은", hired: "2026-09-15" }];

async function units(admin: Page) {
  // The 부서 on the org chart (trunk's cs-chart; /setup/org redirects there).
  await go(admin, "/org");
  await addDepartments(admin, "한결 본점", ["인사팀", "생산팀"]);
}

async function upload(admin: Page, name: string, buffer: Buffer, open = true) {
  if (open) await go(admin, "/people/import");
  await chooseWorkbook(admin, name, buffer);
  await payPeriod(admin);
  await button(admin, "명부 미리보기").click();
  await expect(step(admin)).toHaveText("열 확인", { timeout: 30_000 });
}

test.use(VIEW);

// E7 가져오기 parity (spec employee-ux E7) on FE-PAIR's IMPORT-2 screens: the any-layout journey from an empty company,
// captured at the mockups' states.
/** Every scroller back to its top: the app scrolls inside its main area, not the window. */
const toTop = (page: Page) => page.evaluate(() => [document.scrollingElement, ...document.querySelectorAll("*")].forEach((e) => e && e.scrollTop > 0 && (e.scrollTop = 0)));

test("parity capture: import (E7)", { tag: "@parity" }, async ({ browser }) => {
  parity();
  test.setTimeout(400_000);
  const { admin } = await tenantInSetup(browser, "e7parity", "한결", false, "한결 본점");
  await units(admin);

  // 0. The company's numbering rule: people the file gives no 사번 are numbered by it.
  await go(admin, "/people/numbering");
  await button(admin, "전체 규칙 설정").click();
  await admin.getByLabel(/^전체 사번 앞자리/).fill("HJ-");
  await admin.getByLabel(/^전체 사번 숫자 자릿수/).selectOption({ label: "4자리" });
  await expect(admin.getByText("첫 번호 예: HJ-0001")).toBeVisible();
  await button(admin, "전체 규칙 저장").click();
  await expect(admin.getByRole("row").filter({ hasText: "전체" })).toContainText("앞자리 HJ- · 숫자 4자리");

  // 1. A workbook of four layouts.
  const file = await workbook([titled("본사", "2026년 10월 인사 명부 (대외비)", HQ), crew("현장인력", CREW), notes("메모"), empty("빈시트")]);
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사기록_2026-10.xlsx", file);
  await payPeriod(admin);
  await shot(admin, "E7-upload");
  await button(admin, "명부 미리보기").click();
  await expect(step(admin)).toHaveText("열 확인", { timeout: 30_000 });
  const sheets = admin.getByRole("region", { name: /^시트 4개/ });
  await expect(sheets.getByRole("region", { name: "본사 시트" })).toContainText("머리글 3행");
  await expect(sheets.getByRole("region", { name: "본사 시트" })).toContainText("읽음");
  await expect(sheets.getByRole("region", { name: "빈시트 시트" })).toContainText("빈 시트");
  await expect(sheets.getByRole("region", { name: "메모 시트" })).toContainText("연결 필요");
  await expect(button(admin, "모의 반영 실행")).toHaveAttribute("aria-disabled", "true");
  await expect(admin.getByText("열을 연결하지 않은 시트가 2개 있습니다").first()).toBeAttached();

  // The crew sheet: its header row is chosen from the server's candidates, and each column is said once.
  const crewSheet = sheets.getByRole("region", { name: "현장인력 시트" });
  await expect(crewSheet).toContainText("연결 필요");
  await crewSheet.getByRole("radiogroup", { name: /현장인력 시트의 머리글 행/ }).getByText("2행", { exact: true }).click();
  await crewSheet.getByLabel("현장인력 시트 B열(근로자)의 직원 항목").selectOption({ label: "성명" });
  await expect(button(admin, "현장인력 시트를 이 연결로 다시 읽기")).toBeEnabled();
  await toTop(admin);
  await shot(admin, "E7-columns");
  await crewSheet.getByLabel("현장인력 시트 D열(투입일)의 직원 항목").selectOption({ label: "성명" });
  await expect(button(admin, "현장인력 시트를 이 연결로 다시 읽기")).toHaveAttribute("aria-disabled", "true");
  await crewSheet.getByLabel("현장인력 시트 D열(투입일)의 직원 항목").selectOption({ label: "입사일" });
  await button(admin, "현장인력 시트를 이 연결로 다시 읽기").click();
  await expect(sheets.getByRole("region", { name: "현장인력 시트" })).toContainText("직접 연결");
  // The notes sheet, the one still unread, is open for mapping now: it is left out.
  await expect(button(admin, "메모 시트 열 연결")).toHaveAttribute("aria-expanded", "true");
  await sheets.getByRole("region", { name: "메모 시트" }).getByText("메모 시트는 가져오지 않습니다").click();
  await button(admin, "메모 시트를 이 연결로 다시 읽기").click();
  await expect(sheets.getByRole("region", { name: "메모 시트" })).toContainText("건너뜀");
  await expect(admin.getByRole("table", { name: "열", exact: true }).getByRole("row").filter({ hasText: "주민번호" })).toContainText("가려서 보관 · 원본에 남기지 않음");
  await button(admin, "모의 반영 실행").click();

  // 2. The queue: blocking items first, each answered in one click; the dry run runs again after each.
  await expect(step(admin)).toHaveText("모의 반영", { timeout: 30_000 });
  await expect(admin.getByRole("heading", { name: /^확인 필요 \d+건$/ })).toBeVisible();
  await expect(await gridRow(queue(admin), "장기휴직")).toContainText("반영 막음");
  await expect(button(admin, /^명부 반영/)).toHaveAttribute("aria-disabled", "true");
  await openItem(admin, "장기휴직");
  await panel(admin).getByRole("group", { name: "“장기휴직”의 뜻" }).getByRole("button", { name: "휴직", exact: true }).click();
  // 최지우 is now 휴직 with no 휴직 유형 in the file: the next blocking item asks for it.
  await settled(admin);
  // It opens by itself (the first blocking question): its row is the blank text in 「값 연결 · 휴직 유형」.
  await expect(panel(admin)).toContainText("읽지 못한 휴직 유형");
  await panel(admin).getByRole("button", { name: "기타 휴직" }).click();
  await settled(admin);
  await openItem(admin, "품질팀");
  await shot(admin, "E7-values");
  await panel(admin).getByRole("radiogroup", { name: /품질팀에 연결할 부서/ }).getByText(/생산팀$/).click();
  await settled(admin);
  await expect(button(admin, "명부 반영: 신규 8명 · 갱신 0명")).toBeEnabled();

  // The rows: 휴직 people with their leave, crew numbered by the rule.
  await button(admin, /^휴직 3$/).click();
  await expect(await openRow(admin, "이서연")).toContainText("육아휴직 휴직으로 들어옵니다: 2026-03-01부터, 복직 예정 2027-02-28");
  await button(admin, /^전체 8$/).click();
  await expect(await gridRow(rowsGrid(admin), "강시우")).toContainText("규칙으로 부여");
  await expect(await gridRow(rowsGrid(admin), "강시우")).toContainText("HJ-");
  await toTop(admin);
  await shot(admin, "E7-preview");
  await button(admin, "명부 반영: 신규 8명 · 갱신 0명").click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
  await expect(admin.getByText("신규 8명 · 갱신 0명 · 건너뜀 0명")).toBeVisible();
  // 이관 확인 (BE-EMP-UI §5): the funnels and the placement, then rows checked one by one.
  const check = admin.getByRole("region", { name: "이관 확인" });
  await expect(check.getByRole("table", { name: "시트별 흐름" })).toBeVisible();
  await toTop(admin);
  await shot(admin, "E7-reconcile");
  await shot(admin, "E7-reconcile", { full: true });
  for (let i = 0; i < 5; i++) await check.getByRole("button", { name: "맞음", exact: true }).click();
  await check.getByRole("textbox", { name: "다른 점" }).fill("휴직 시작일이 원본과 다름");
  await check.getByRole("button", { name: "다름 · 다시 볼 것" }).click();
  await check.getByRole("textbox", { name: "다른 점" }).scrollIntoViewIfNeeded();
  await shot(admin, "E7-row");
  await check.getByRole("button", { name: /채로 확인 기록$/ }).scrollIntoViewIfNeeded();
  await shot(admin, "E7-signoff");
  await check.getByRole("button", { name: /채로 확인 기록$/ }).click();
  await expect(check.getByRole("status").filter({ hasText: "확인을 남겼습니다" })).toBeVisible();

  // 3. A second file in the plain layout: 품질팀 is remembered, 이서연 is found by her 주민등록번호 alone, and the
  //    김민준 without a 사번 is one of two people on file of that name: told apart, never guessed.
  const second: Row[] = [
    { name: "김민준", unit: "생산팀", position: "사원", hired: "2019-07-01" },
    { name: "이서연", unit: "인사팀", position: "대리", hired: "2018-01-15", birth: "1990-02-03", rrn: HQ[2]!.rrn },
    { number: "HJ-0201", name: "한지민", unit: "품질팀", position: "사원", hired: "2024-01-02", birth: "1998-05-05" },
  ];
  // From the result, as a user starts the next file (the same screen starts over).
  await admin.getByRole("link", { name: "다른 명부 가져오기" }).click();
  await upload(admin, "인사기록_추가.xlsx", await workbook([plain("본사", second)]), false);
  await button(admin, "모의 반영 실행").click();
  await expect(step(admin)).toHaveText("모의 반영", { timeout: 30_000 });
  // 품질팀 is answered from the company's memory: listed among the value links, tagged so.
  await expect(await gridRow(queue(admin), "품질팀")).toContainText("전에 선택한 값");
  await expect(await gridRow(rowsGrid(admin), "이서연")).toContainText("주민등록번호");
  await openItem(admin, "누구인지 확인");
  for (const t of ["HJ-0101", "HJ-0102", "본사 · 인사팀", "본사 · 생산팀", "생년월일 1985-04-**", "생년월일 1992-11-**"]) await expect(panel(admin)).toContainText(t);
  await shot(admin, "E7-update");
  await panel(admin).getByRole("button", { name: "이 사람입니다 (HJ-0102)" }).click();
  await settled(admin);
  const apply = admin.getByRole("button", { name: /^명부 반영: 신규 1명 · 갱신 \d+명$/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
});
