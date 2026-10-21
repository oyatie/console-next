import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { clickCounter } from "../clicks";
import { go } from "../flows";
import { reasonChip } from "../helpers/lifecycle";
import { startOperations } from "../setup-flows";
import { cardHeading, cutRecordUpdates, openByNumber, pick, restoreRecordUpdates, sheet } from "./steps";
import { HERO, saeonInSetup, staffSaeon } from "./universe";

// The employee record (spec employee-ux/final E1 E2 E4 E9 E10 E12) as a solo HR administrator, from an empty database
// through the product: the click budgets of spec §5 and the refusals each screen must show (owner rule 2026-10-07).

const dark = async (page: Page, on: boolean) => {
  await page.getByRole("button", { name: on ? "어두운 화면으로 전환" : "밝은 화면으로 전환" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", on ? "dark" : "light");
};

test("roster: first run, counts that add up, 3-year retention, a void in setup and one refused", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(600_000); // a tenant from nothing, 34 people imported, then the journey
  const { admin: a } = await saeonInSetup(browser, "saeonroster");
  await go(a, "/people");
  // E12-first-run: one registration path and one import path; nothing pretends to list people.
  await expect(a.getByRole("heading", { name: "아직 직원이 없습니다" })).toBeVisible();
  await expect(a.getByText(/조직 구조 준비됨/)).toHaveCount(0);
  await expect(a.getByRole("main").getByRole("link", { name: /^직원 등록/ })).toHaveCount(1);
  await expect(a.getByRole("main").getByRole("link", { name: "가져오기", exact: true })).toHaveCount(1);
  await expect(a.getByRole("button", { name: "붙여넣기" })).toHaveCount(0);
  await expectAccessible(a, "E12 first run");
  await staffSaeon(a);
  // The import went through the API behind this page's back: a fresh load reads it (the app's own import invalidates).
  await a.goto("/people");

  // E1: 재직 + 휴직 = 인원, 입사 예정 apart, the exited behind their own chip with the retention the law sets.
  const status = a.getByRole("group", { name: "상태" });
  await expect(status.getByRole("button", { name: /^재직 29$/ })).toBeVisible({ timeout: 15_000 });
  await expect(status.getByRole("button", { name: /^휴직 1$/ })).toBeVisible();
  await expect(status).toContainText("= 인원 30");
  await expect(status.getByRole("button", { name: /^입사 예정 · 따로 1$/ })).toBeVisible();
  await expectAccessible(a, "E1 roster");
  await dark(a, true);
  await expectAccessible(a, "E1 roster (dark)");
  await dark(a, false);
  await status.getByRole("button", { name: /^퇴직 · 3년 보관 3$/ }).click();
  await expect(a.getByRole("note").filter({ hasText: "근로기준법 제42조" })).toHaveCount(0);
  await expect(a.getByRole("row", { name: /최도현/ })).toContainText("2028. 11. 17.");
  // E9-exited: the read-only peek of an exit (retention, what follows past it, the other ways on).
  await a.getByRole("rowheader", { name: "최도현" }).click();
  await expect(a.getByRole("complementary").getByText("보존 기한", { exact: true })).toBeVisible();
  await expectAccessible(a, "E9 exit peek");
  await a.getByRole("complementary").getByRole("button", { name: "직원 상세 닫기" }).click();
  await expect(a.getByRole("complementary")).toHaveCount(0);

  // E9 for someone who has left, in setup: CRUD's 등록 취소 sheet (the ⋯ menu opens it) follows the server's end-options —
  // the setup delete of an exited person inside the 명부 period asks that the original register is kept, unticked
  // (the refusal of a used record after go-live is crud-people.spec's).
  await openByNumber(a, "10201", "최도현", "EXITED");
  await a.getByRole("group", { name: "인사카드 동작" }).getByRole("button", { name: "더 보기" }).click();
  await a.getByRole("menuitem", { name: /등록 취소/ }).click();
  await expect(sheet(a).getByRole("checkbox", { name: "원본 근로자 명부를 따로 보관하고 있습니다" })).not.toBeChecked();
  await a.keyboard.press("Escape");

  // E9-void in setup: a pre-hire registered by mistake goes in ≤ 6 clicks (spec §5) through CRUD's sheet (the setup delete),
  // and the roster drops it.
  const c = clickCounter();
  await openByNumber(a, "10655", "백시우");
  await c.click(a.getByRole("group", { name: "인사카드 동작" }).getByRole("button", { name: "더 보기" }));
  await c.click(a.getByRole("menuitem", { name: /등록 취소/ }));
  const voiding = sheet(a);
  const commit = voiding.getByRole("button", { name: "등록 취소", exact: true });
  await commit.press("Enter"); // a check: nothing is chosen (aria-disabled, R9), so it goes to what is missing and cancels nothing
  await expect(voiding.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(voiding).toBeVisible();
  await c.click(pick(voiding, /취소하는 이유/, "입사하지 않음"));
  const kept = voiding.getByText("원본 근로자 명부를 따로 보관하고 있습니다");
  if (await kept.isVisible()) await c.click(kept);
  await expectAccessible(a, "E9 void sheet");
  await c.click(commit);
  await expect(voiding).toBeHidden();
  expect(c.done("E9 void a mistaken registration")).toBeLessThanOrEqual(6);
  await go(a, "/people");
  await expect(a.getByRole("group", { name: "상태" }).getByRole("button", { name: /^입사 예정 · 따로 0$/ })).toBeVisible();
  // The voided registration is kept apart from the exited: listed with its number (never reused) and the reason.
  await a.getByRole("group", { name: "상태" }).getByRole("button", { name: /^퇴직 · 3년 보관/ }).click();
  await a.getByRole("group", { name: "퇴직자 목록" }).getByRole("button", { name: /^취소된 등록 1$/ }).click();
  // A void in setup destroys the personal data at once (the name reads as destroyed), the reason stays.
  await expect(a.getByRole("table", { name: "취소된 등록" }).getByRole("row").filter({ hasText: /입사/ })).toBeVisible();
  await expectAccessible(a, "E9 voided registrations");

  // E10-register: a workplace under its company, nothing preselected; the preview stays masked (light and dark).
  await go(a, "/people?export=register");
  await a.getByRole("radiogroup", { name: /사업장/ }).getByText("평택공장", { exact: true }).click();
  await expect(a.getByText(/근로자 [1-9]\d*명/)).toBeVisible();
  // The lines are there before "no …" means anything (an empty table holds no "…" either), then every fact has landed.
  const preview = a.getByRole("table", { name: "명부 미리 보기" });
  await expect(preview.getByRole("row").nth(1)).toBeVisible({ timeout: 15_000 });
  await expect(preview).not.toContainText("…", { timeout: 15_000 });
  await expectAccessible(a, "E10 register export");
  await dark(a, true);
  await expectAccessible(a, "E10 register export (dark)");
  await dark(a, false);
});

test("record card: a hire date corrected within budget, a taken number refused, a stale sheet keeps what was typed", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(600_000); // a tenant from nothing, 34 people imported, then the journey
  const { admin: a } = await saeonInSetup(browser, "saeoncard");
  await staffSaeon(a);
  await startOperations(a);
  const c = clickCounter();
  // ⌘K 사번 Enter opens the record without a click (spec §3).
  await go(a, "/people");
  await expect(a.getByRole("searchbox", { name: "이름 또는 사번" })).toBeVisible();
  await a.keyboard.press("ControlOrMeta+k");
  await a.getByRole("searchbox", { name: "찾기와 이동" }).fill(HERO.no);
  await expect(a.getByRole("option", { name: new RegExp(`^${HERO.name} ${HERO.no}`) })).toBeVisible(); // the person, first
  await a.keyboard.press("Enter");
  await expect(cardHeading(a)).toBeVisible();
  await expectAccessible(a, "E2 card");
  await dark(a, true);
  await expectAccessible(a, "E2 card (dark)");
  await dark(a, false);

  // E4-hire-correct: 정정만 → date → reason → 정정 요청 (≤ 7 with the proofs spec §5 counts; 증빙 is not served).
  await c.click(a.getByRole("button", { name: "입사일 수정", exact: true }));
  const fix = sheet(a);
  await fix.getByRole("textbox", { name: "입사일" }).fill("2019-03-04");
  await expect(fix).toContainText("2019. 03. 04.");
  await c.click(pick(fix, /왜 정정합니까/, "원본 서류와 다름"));
  await expectAccessible(a, "E4 hire-date correction");
  await c.click(fix.getByRole("button", { name: "정정 요청", exact: true }));
  await expect(a.getByRole("status").filter({ hasText: "검토 표시" })).toBeVisible();
  expect(c.done("E4 correct a mistyped hire date")).toBeLessThanOrEqual(7);
  await expect(a.getByRole("group", { name: "소속" })).toContainText("2019. 03. 04.");

  // E2-reveal: 보기 → reason → 보기 (3, spec §5); without a reason it does not open.
  await c.click(a.getByRole("button", { name: "생년월일 보기 · 사유를 선택합니다" }));
  // Refused: no reason yet (the primary is aria-disabled but focusable, R9), so pressing it goes to the reasons.
  await a.getByRole("button", { name: "보기", exact: true }).press("Enter");
  await expect(a.getByRole("radiogroup", { name: /왜 봅니까/ }).getByRole("radio").first()).toBeFocused();
  await c.click(pick(a, /왜 봅니까/, "법정 신고"));
  await c.click(a.getByRole("button", { name: "보기", exact: true }));
  await expect(a.getByRole("region", { name: "인적사항" })).toContainText("1994. 08. 21.");
  expect(c.done("E2 reveal a masked field")).toBeLessThanOrEqual(3);

  // The 주민등록번호 (decisions #25): masked; no reason, nothing opens; with one the server returns it (and logs it).
  const rrnField = a.getByRole("region", { name: "인적사항" });
  await expect(rrnField).toContainText(/940821-1●{6}/);
  await a.getByRole("button", { name: "주민등록번호 보기 · 사유를 선택합니다" }).click();
  await a.getByRole("button", { name: /^보기/ }).press("Enter");
  await expect(a.getByRole("radiogroup", { name: /왜 봅니까/ }).getByRole("radio").first()).toBeFocused();
  await a.getByRole("radiogroup", { name: /왜 봅니까/ }).locator("label").first().click();
  await expectAccessible(a, "E2 RRN reveal");
  await a.getByRole("button", { name: /^보기/ }).click();
  await expect(rrnField).toContainText(/940821-1\d{6}/);

  // E4-empno-change (refusal): a number someone holds is named with its holder; pressing goes back to it, nothing changes.
  await a.getByRole("group", { name: "인사카드 동작" }).getByRole("button", { name: "더 보기" }).click();
  await a.getByRole("menuitem", { name: "사번 변경" }).click();
  const empno = sheet(a);
  await expect(empno.getByText(/지금 사번·예전 사번·취소한 등록·예약된 번호/)).toHaveCount(0);
  await empno.getByRole("textbox", { name: "새 사번" }).fill("10422");
  await expect(empno.getByText(/이미 쓰는 사번입니다/)).toBeVisible();
  await expect(empno.getByRole("textbox", { name: "새 사번" })).toHaveAccessibleDescription(/이미 쓰는 사번입니다/);
  await pick(empno, /언제부터/, "오늘부터").click();
  await reasonChip(empno, "사번 체계 변경", "사유").click();
  await empno.getByRole("button", { name: "사번 변경", exact: true }).press("Enter"); // aria-disabled (R9): goes to the number
  await expect(empno.getByRole("textbox", { name: "새 사번" })).toBeFocused();
  await a.keyboard.press("Escape");
  await expect(cardHeading(a).locator("..")).toContainText(HERO.no);

  // E12-conflict-sheet (refusal): the person changed after the sheet opened; nothing is saved, the three values show,
  // and dropping mine leaves the record as the other writer left it.
  await a.getByRole("button", { name: "성별 수정" }).click();
  await pick(sheet(a), /^성별/, "여").click();
  await pick(sheet(a), /왜 정정합니까/, "입력 실수").click();
  const other = await a.context().newPage();
  await other.goto(a.url().split("?")[0]!);
  await other.getByRole("button", { name: "업무 이메일 수정" }).click();
  await other.getByRole("textbox", { name: "업무 이메일" }).fill("hajun@saeon.example");
  await other.getByRole("textbox", { name: "업무 이메일" }).press("Enter");
  await expect(other.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();
  await other.close();
  await sheet(a).getByRole("button", { name: "정정", exact: true }).click();
  await expect(sheet(a).getByText(/시트를 연 뒤 다른 사람이/)).toBeVisible();
  await expectAccessible(a, "E12 conflict in a sheet");
  await sheet(a).getByText("내 값을 버리고 지금 값을 둡니다").click();
  await sheet(a).getByRole("button", { name: "선택대로 저장" }).click();
  await expect(sheet(a)).toBeHidden();
  await expect(a.getByRole("region", { name: "인적사항" })).toContainText("hajun@saeon.example");
  await expect(a.getByRole("region", { name: "인적사항" })).not.toContainText(/성별\s*여/);

  // E12-conflict (refusal): a quick edit that lost a race saves nothing, shows the other value at the field, and the
  // save waits for a choice (none preselected); keeping mine then records it. The race is a change the event stream did
  // not bring in time (when it does, the shown record re-reads before the edit): this tab's stream is down meanwhile.
  await cutRecordUpdates(a);
  await expect(a.getByRole("region", { name: "인적사항" })).toContainText("hajun@saeon.example");
  const rival = await a.context().newPage();
  await rival.goto(a.url().split("?")[0]!);
  await rival.getByRole("button", { name: "개인 이메일 수정" }).click();
  await rival.getByRole("textbox", { name: "개인 이메일" }).fill("theirs@mail.example");
  await rival.getByRole("textbox", { name: "개인 이메일" }).press("Enter");
  await expect(rival.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();
  await rival.close();
  await a.getByRole("button", { name: "개인 이메일 수정" }).click();
  await a.getByRole("textbox", { name: "개인 이메일" }).fill("mine@mail.example");
  await a.getByRole("textbox", { name: "개인 이메일" }).press("Enter");
  const clash = a.getByRole("group", { name: /먼저 변경했습니다/ });
  await expect(clash.getByText(/^그 값 사용 · theirs@mail\.example/)).toBeVisible({ timeout: 15_000 });
  await expect(clash.getByRole("radio", { checked: true })).toHaveCount(0);
  await clash.getByRole("button", { name: "선택대로 저장" }).press("Enter"); // nothing chosen: it goes to the choice
  await expect(clash).toBeVisible();
  await expectAccessible(a, "E12 conflict at a field");
  await clash.getByText(/^내 값 유지/).click();
  await clash.getByRole("button", { name: "선택대로 저장" }).click();
  await expect(clash).toBeHidden();
  await expect(a.getByRole("region", { name: "인적사항" })).toContainText(/m•{4}@•{4}\.example|mine@mail\.example/);
  // The stream comes back and its outage note leaves the top bar: what that moved is the test's cut, not a screen's.
  await restoreRecordUpdates(a);
  await a.evaluate(() => void window.__shifts?.splice(0));

  // E10-print: the 인사기록카드 paper beside its options (light and dark; the paper itself stays light).
  await a.getByRole("group", { name: "인사카드 동작" }).getByRole("button", { name: "인사카드 인쇄" }).click();
  await expect(a.getByRole("article", { name: "인쇄 미리 보기" })).toContainText(HERO.no);
  await expectAccessible(a, "E10 print");
  await dark(a, true);
  await expectAccessible(a, "E10 print (dark)");
  await dark(a, false);
  await a.getByRole("button", { name: "닫고 인사카드로" }).click();
});
