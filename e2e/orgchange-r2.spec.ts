import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { withLifecycleDate } from "./clock";
import { go, kstDate, registerEmployee } from "./flows";
import { addDepts, openUnit, sheet } from "./helpers/structure";
import { registerBranch, startOperations, tenantInSetup } from "./setup-flows";
import { box } from "./structure-flows";
import { openHistory } from "./record";
import { holdRead } from "./helpers/read";

// UX-R2 ORGCHANGE (regression: org-01, org-02, org-03, org-07, org-17, org-19, org-25, org-26). After go-live every
// structure change is an org change: it moves its people with it, says what it does, leaves a receipt on the chart,
// applies on its date by itself and can be moved or cancelled until then — and, with org changes not routed (#26, the
// default), nothing on the way speaks of 기안, 상신 or 결재.

const APPROVAL = /기안|상신|결재/;
/** The receipt the last change left on the chart, with its record link. */
const receipt = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("link", { name: /^OC-\d{4}-\d{4} 기록 보기$/ }) });
/** Registers a person into `unit` through the 직원 등록 sheet (it takes the 사업장 from the unit) and returns their record's path. */
async function registerAt(page: Page, name: string, unit: string) {
  await registerEmployee(page, { name, unit, hired: kstDate(-30) });
  return new URL(page.url()).pathname;
}
/** Today's date and reason on an open governed form (sheet or move page). */
async function today(scope: ReturnType<Page["getByRole"]>, reason: string) {
  await scope.getByRole("button", { name: /^오늘/ }).first().click();
  await scope.getByRole("textbox", { name: /^사유/ }).first().fill(reason);
}

test("an org change moves its people with the unit, stays on the chart with a receipt and speaks no 결재", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  test.setTimeout(360_000); // a tenant with two 사업장 and two people, then a move, a merge and four screens read
  const { admin } = await tenantInSetup(browser, "ocr2move", "구조변경");
  await registerBranch(admin, "구조변경", "판교연구소", "0008512347");
  await addDepts(admin, "본점", ["경영지원본부", "인사팀", "영업3팀"]);
  await addDepts(admin, "판교연구소", ["개발팀"]);
  const park = await registerAt(admin, "박개발", "개발팀");
  await registerAt(admin, "정영업", "영업3팀");
  await startOperations(admin);

  // org-03: the phase line says changes apply on their date and are corrected by a new one; no approval anywhere.
  await go(admin, "/org");
  await expect(admin.getByText(/^운영 중 · 변경한 내용은 시행일에 반영되고/)).toBeVisible();
  await expect(admin.getByRole("main")).not.toContainText(APPROVAL);

  // org-01: moving 개발팀 under 본점 › 경영지원본부 counts the person whose 사업장 changes, and keeps that promise.
  const dev = await openUnit(admin, "개발팀");
  await dev.getByRole("button", { name: "이동", exact: true }).first().click();
  await expect(admin).toHaveURL(/\/org\/move\?ids=/);
  await admin.getByRole("treegrid", { name: "어디로" }).getByRole("row", { name: /^경영지원본부/ }).click();
  const totals = admin.getByRole("region", { name: "무엇이 어떻게 바뀌나" });
  await expect(totals.getByRole("term").filter({ hasText: /^사업장이 바뀌는 사람$/ }).locator("xpath=preceding-sibling::dd[1]")).toHaveText("1");
  await today(admin.getByRole("main"), "개발 조직 본점 이전");
  await expect(admin.getByRole("main")).not.toContainText(APPROVAL);
  await admin.getByRole("button", { name: "부서 이동 1개 반영" }).click();

  // org-19, org-25: back on the chart, a receipt names the change by what it does and links its record.
  await expect(admin).toHaveURL(/\/org(\?|$)/);
  await expect(receipt(admin)).toContainText("개발팀을 경영지원본부 아래로 이동");
  await expect(receipt(admin)).toContainText("반영했습니다");

  // The person moved with the unit: 사업장 본점, and a dated 발령 in their history (was: still 판교연구소, no 발령).
  // A cached pre-move history must not draw controls before the fresh transfer read lands.
  const events = await holdRead(admin, `**/api/v1/employees/${park.split("/").at(-1)}/lifecycle-events`);
  await go(admin, park);
  await events.requested;
  try {
    await expect(admin.getByRole("group", { name: "인사카드 동작" })).toBeHidden();
  } finally {
    await events.release();
  }
  // 사업장 본점 from today, 판교연구소 until today: the assignment split on the 시행일 (was: 판교연구소 with no end).
  // On the card: section 2 (재직·배치) holds the placement history; the 발령 이력 tab holds the history.
  await expect(admin.getByRole("region", { name: "재직·배치" })).toContainText(/사업장본점 · \d{4}\. \d{2}\. \d{2}\.부터/);
  await expect(admin.getByRole("region", { name: "재직·배치" })).toContainText(/판교연구소 · \d{4}\. \d{2}\. \d{2}\.~/);
  await openHistory(admin);
  await expect(admin.getByRole("region", { name: "인사 이력" })).toContainText("전보");

  // The record counts the people it moved, and its words are 반영 · 기록, never 기안 or 결재.
  await go(admin, "/org");
  await expect(admin.getByRole("link", { name: "변경 내역" })).toBeVisible(); // org-26: not inside the import menu
  await go(admin, "/org/changes");
  await expect(admin.getByRole("main")).not.toContainText(APPROVAL);
  await go(admin, "/org/changes?view=done");
  await admin.getByRole("row", { name: /개발팀을 경영지원본부 아래로 이동/ }).getByRole("link").first().click();
  await expect(admin).toHaveURL(/\/org\/changes\/[0-9a-f-]+/);
  await expect(admin.getByRole("main")).toContainText("1명 · 이 변경으로 소속이나 사업장이 바뀐 사람");
  await expect(admin.getByRole("main")).not.toContainText(APPROVAL);
  await expectAccessible(admin, "ORGCHANGE: an applied move's record");

  // org-07: a merge keeps its successor and says the unit is kept in the history, never deleted.
  const sales = await openUnit(admin, "영업3팀");
  await sales.getByRole("button", { name: "통합" }).click();
  const merge = sheet(admin, "영업3팀 통합");
  await merge.getByRole("treegrid", { name: "어느 부서로" }).getByRole("row", { name: /^인사팀/ }).click();
  await expect(merge).not.toContainText("삭제됩니다");
  await expect(merge).toContainText("이력에 남음");
  await today(merge, "영업 조직 통합");
  await merge.getByRole("button", { name: "부서 통합 1개 반영" }).click();
  await expect(receipt(admin)).toContainText("영업3팀을 인사팀에 합침");
  await expect(box(admin, "영업3팀")).toHaveCount(0);
  await receipt(admin).getByRole("link", { name: /기록 보기$/ }).click();
  await expect(admin.getByRole("main")).toContainText("영업3팀을 인사팀에 합침 (폐지, 이력에 남음)");

  // org-17: the moved unit's history tab counts the lines its list shows.
  const dev2 = await openUnit(admin, "개발팀");
  const anchor = dev2.getByRole("navigation", { name: "패널 안 바로 가기" }).getByRole("button", { name: /^이력 \d+$/ });
  const count = Number((await anchor.textContent())?.match(/\d+/)?.[0]);
  await anchor.click();
  const history = dev2.getByRole("region", { name: "이력" });
  await expect(history.getByRole("listitem")).toHaveCount(count);
  await expect(history).toContainText("이동 · 판교연구소 → 경영지원본부");

  // /org/history speaks no approval either.
  await go(admin, "/org/history");
  await expect(admin.getByRole("main")).not.toContainText(APPROVAL);
});

test("a scheduled change can be moved or cancelled, frees its unit when cancelled, and applies on its date by itself", { tag: ["@org", "@clock", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000); // a tenant, two scheduled changes, a cancel and the clock moved to the 시행일
  const { admin } = await tenantInSetup(browser, "ocr2plan", "예약변경");
  await addDepts(admin, "본점", ["영업1팀", "영업2팀"]);
  await registerEmployee(admin, { name: "김영업", unit: "영업2팀" });
  await startOperations(admin);
  const due = kstDate(3);

  // A rename dated in three days: 예약, and the chart says so next to its as-of date (org-26).
  const s1 = await openUnit(admin, "영업1팀");
  await s1.getByRole("button", { name: "이름 변경" }).click();
  const rename = sheet(admin, "영업1팀 이름 변경");
  await rename.getByRole("textbox", { name: /^새 이름/ }).fill("국내영업팀");
  await rename.getByRole("textbox", { name: /^시행일/ }).fill(due);
  await rename.getByRole("textbox", { name: /^사유/ }).fill("영업 조직 이름 정리");
  await rename.getByRole("button", { name: "부서 이름 변경 1개 예약" }).click();
  await expect(receipt(admin)).toContainText("영업1팀 → 국내영업팀 이름 변경");
  await expect(admin.getByRole("link", { name: "예정 1건" })).toBeVisible();

  // A 폐지 of 영업2팀 dated the same day holds the unit; its panel links the change that holds it (org-02).
  const s2 = await openUnit(admin, "영업2팀");
  await s2.getByRole("button", { name: "폐지" }).click();
  const dissolve = sheet(admin, "영업2팀 폐지");
  await dissolve.getByRole("textbox", { name: /^시행일/ }).fill(due);
  await dissolve.getByRole("textbox", { name: /^사유/ }).fill("영업 조직 통합");
  await dissolve.getByRole("button", { name: "부서 폐지 1개 예약" }).click();
  await expect(admin.getByRole("link", { name: "예정 2건" })).toBeVisible();
  const held = await openUnit(admin, "영업2팀");
  await held.getByRole("link", { name: /^이 부서를 붙잡고 있는 OC-\d{4}-\d{4} 열기/ }).click();

  // 예약 취소 says what it does first; the unit is free again and nothing changed on the chart.
  await expect(admin.getByRole("main")).not.toContainText(APPROVAL);
  await admin.getByRole("button", { name: "예약 취소", exact: true }).click();
  const cancel = admin.getByRole("dialog", { name: /예약 취소$/ });
  await expect(cancel).toContainText("반영되지 않습니다");
  await cancel.getByRole("textbox", { name: /^취소 사유/ }).fill("통합 보류");
  await cancel.getByRole("button", { name: "조직 변경 취소" }).click();
  await expect(admin.getByRole("button", { name: "예약 취소", exact: true })).toBeHidden();
  const freed = await openUnit(admin, "영업2팀");
  await expect(freed.getByRole("link", { name: /^이 부서를 붙잡고 있는/ })).toHaveCount(0);
  await expect(admin.getByRole("link", { name: "예정 1건" })).toBeVisible();

  // On its date the rename applies with nobody pressing anything.
  await admin.getByRole("link", { name: "예정 1건" }).click();
  await admin.getByRole("row", { name: /영업1팀 → 국내영업팀 이름 변경/ }).getByRole("link").first().click();
  const record = new URL(admin.url()).pathname;
  await expect(admin.getByRole("button", { name: "예약 수정", exact: true })).toBeVisible();
  await withLifecycleDate(due, async () => {
    await expect(async () => {
      await admin.goto(record);
      await expect(admin.getByRole("main")).toContainText("반영됨", { timeout: 2_000 });
    }).toPass({ intervals: [2_000, 3_000, 5_000], timeout: 45_000 });
  });
  // the chart reads the real date, so 국내영업팀 shows there from the real 시행일; the record proves the apply.
});
