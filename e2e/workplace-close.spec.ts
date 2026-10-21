import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, registerSheet } from "./flows";
import { hire, openClose } from "./helpers/close";
import { addDepts } from "./helpers/structure";
import { registerBranch, startOperations, tenantInSetup } from "./setup-flows";
import { box, findBox, leaveScreen } from "./structure-flows";

// UX-R2 ENDS (company-01, worst-case-18, move-17, company-35, worst-case-46): a 사업장 that still has people and 부서
// closes in one act, by a plan with a line for everyone — never 「이 서버가 아직 하지 못합니다」, never a dead end for a solo
// admin. Regression: on the parent the sheet's commit stays disabled with that copy whenever anyone is still there.

const SHOTS = process.env.ENDS_SHOTS;
/** Picks `choice` in the plan SelectField labelled `label` (move-29: the canonical control, not a native select). */
async function plan(page: Page, scope: ReturnType<Page["getByRole"]>, label: string, choice: string) {
  await scope.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name: new RegExp(`^${choice}`) }).click();
}
const shot = (p: Page, name: string) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());

test("regression: a staffed workplace closes today in one act by its plan (company-01, worst-case-18)", { tag: "@org" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "wpclose", "닫는회사", false, "본사");
  await addDepts(admin, "본사", ["인사팀"]);
  await registerBranch(admin, "닫는회사", "판교지점", "0008512347");
  await addDepts(admin, "판교지점", ["개발팀", "물류팀"]);
  await hire(admin, "김개발", "개발팀", "판교지점");
  await hire(admin, "이물류", "물류팀", "판교지점");
  await go(admin, "/setup/go-live");
  await shot(admin, "setup-go-live");
  await startOperations(admin);
  await leaveScreen(admin);

  const s = await openClose(admin, "판교지점");
  const commit = s.getByRole("button", { name: "판교지점 폐쇄" });
  // The old dead end is gone; a disabled commit names the one thing left, in order.
  await expect(s).not.toContainText("아직 하지 못합니다");
  await expect(commit).toHaveAttribute("aria-disabled", "true");
  await expect(commit).toHaveAccessibleDescription("폐쇄일을 선택하면 닫을 수 있습니다.");
  await expect(commit).toHaveClass(/btn--danger/); // company-13: the irreversible commit is the danger action
  await s.getByRole("textbox", { name: /^폐쇄일/ }).fill(kstDate());
  await expect(commit).toHaveAccessibleDescription(/개발팀 부서의 계획이 남았습니다/);
  await shot(admin, "after-01-plan-empty");
  // A person's own row offers 전적 to another 법인 (one person at a time: each consents for themself); "all" does not.
  await s.getByRole("button", { name: /김개발 계획$/ }).click();
  await expect(admin.getByRole("option", { name: "다른 법인으로 전적" })).toBeVisible();
  await admin.keyboard.press("Escape");
  await s.getByRole("button", { name: /개발팀 1명 모두의 계획$/ }).click();
  await expect(admin.getByRole("option", { name: "다른 법인으로 전적" })).toHaveCount(0);
  await admin.keyboard.press("Escape");

  // One press plans everyone; one person is changed to 퇴직 · 폐업 in the table; the preview counts exactly.
  await s.getByRole("button", { name: "모두 본사로" }).click();
  await expect(s).toContainText("본사로 전근 2명");
  await expect(s).toContainText("부서 2개 옮김 · 0개 폐지");
  await expect(commit).not.toHaveAttribute("aria-disabled", "true");
  await plan(admin, s, "물류팀 계획", "폐지");
  await expect(commit).toHaveAccessibleDescription(/이물류님의 계획이 남았습니다/);
  await plan(admin, s, "이물류 계획", "전근");
  await s.getByRole("button", { name: "이물류가 갈 곳" }).click();
  const where = admin.getByRole("dialog", { name: /이물류가 갈 곳/ });
  // The closing 사업장 and its 부서 stay listed but cannot be picked.
  await expect(where.getByRole("row", { name: /^개발팀/ })).toHaveAttribute("aria-disabled", "true");
  await expectAccessible(admin, "workplace close destination picker");
  await where.getByRole("row", { name: /^인사팀/ }).click();
  await expect(s).toContainText("부서 1개 옮김 · 1개 폐지");
  await shot(admin, "after-02-plan-filled");
  await expectAccessible(admin, "workplace close plan");

  await commit.click();
  await expect(s.getByRole("status").filter({ hasText: /닫힘/ })).toBeVisible();
  await shot(admin, "after-03-closed");
  await s.getByRole("button", { name: "닫기", exact: true }).last().click();
  // The chart: 개발팀 now sits under 본사 with its person; 판교지점 is closed.
  await go(admin, "/org");
  await expect(box(admin, "판교지점")).toContainText("폐쇄됨");
  await findBox(admin, "개발팀");
  await expect(box(admin, "개발팀")).toBeVisible();
  await shot(admin, "after-04-chart");

  // worst-case-10: registering someone offers neither the closed 사업장 nor a 부서 under it; 개발팀 is offered at 본사.
  await go(admin, "/people/new");
  await registerSheet(admin).getByRole("combobox", { name: "둘 곳" }).fill("개발");
  await expect(admin.getByRole("option", { name: /본사 › 개발팀/ })).toBeVisible();
  await expect(admin.getByRole("option", { name: /판교지점/ })).toHaveCount(0);
  await expect(admin.getByRole("radio", { name: /판교지점/ })).toHaveCount(0);
  await shot(admin, "after-09-picker");
});

test("a refused plan names who and why and changes nothing; a later close is scheduled, withdrawn and planned again with exits", { tag: ["@regression", "@org"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "wpclose2", "예약회사", false, "본사");
  await addDepts(admin, "본사", ["인사팀"]);
  await registerBranch(admin, "예약회사", "판교지점", "0008512347");
  await addDepts(admin, "판교지점", ["개발팀"]);
  await hire(admin, "김개발", "개발팀", "판교지점");
  await hire(admin, "박신입", "개발팀", "판교지점", kstDate());
  await startOperations(admin);
  await leaveScreen(admin);

  // Today: 박신입's placement starts today, so they cannot move today. The server refuses the whole plan, naming them.
  let s = await openClose(admin, "판교지점");
  await s.getByRole("textbox", { name: /^폐쇄일/ }).fill(kstDate());
  await s.getByRole("button", { name: "모두 본사로" }).click();
  await s.getByRole("button", { name: "판교지점 폐쇄" }).click();
  await expect(s.getByRole("alert")).toContainText("박신입: 배치가 폐쇄일에 시작돼 그날 전근할 수 없습니다");
  await shot(admin, "after-05-refused");
  await expectAccessible(admin, "workplace close refused");
  await s.getByRole("button", { name: "취소" }).click();
  await go(admin, "/org");
  await expect(box(admin, "판교지점")).not.toContainText("폐쇄됨");

  // Tomorrow: scheduled; nothing moves before the day. The reopened sheet shows the planned close, not a second plan.
  s = await openClose(admin, "판교지점");
  await s.getByRole("textbox", { name: /^폐쇄일/ }).fill(kstDate(1));
  await s.getByRole("button", { name: "모두 본사로" }).click();
  await expect(s.getByRole("contentinfo").or(s)).toContainText("그 전에는 아무것도 바뀌지 않습니다");
  await s.getByRole("button", { name: "판교지점 폐쇄" }).click();
  await expect(s.getByRole("status").filter({ hasText: /닫힐 예정/ })).toBeVisible();
  await s.getByRole("button", { name: "닫기", exact: true }).last().click();
  s = await openClose(admin, "판교지점");
  await expect(s.getByRole("status").filter({ hasText: /닫힐 예정/ })).toBeVisible();
  await shot(admin, "after-06-scheduled");
  await s.getByRole("button", { name: "폐쇄 계획 취소" }).click();

  // Planned again, both leaving (폐업): their exits open now (마지막 근무일 today), and the close waits for them.
  await s.getByRole("textbox", { name: /^폐쇄일/ }).fill(kstDate(1));
  await plan(admin, s, "개발팀 계획", "폐지");
  await plan(admin, s, "개발팀 2명 모두의 계획", "퇴직 · 폐업");
  await expect(s).toContainText("퇴직 2명 (폐업 2 · 도산 0)");
  await expect(s).toContainText("인사 확인이 끝나면 1분 안에 사업장이 닫힙니다");
  await s.getByRole("button", { name: "판교지점 폐쇄" }).click();
  const planned = s.getByRole("status").filter({ hasText: /닫힐 예정/ });
  await expect(planned).toContainText("퇴직 2명");
  await expect(planned).toContainText("인사 확인이 남은 퇴직 2명");
  // move-29: each exit the close opened is named and links its case.
  await expect(planned.getByRole("list", { name: "확인을 기다리는 퇴직" }).getByRole("link")).toHaveCount(2);
  await expect(planned.getByRole("link", { name: "퇴직 처리 목록 보기" })).toBeVisible();
  await shot(admin, "after-07-exits-scheduled");
  await go(admin, "/people/exits");
  await expect(admin.getByRole("main")).toContainText("김개발");
  await expect(admin.getByRole("main")).toContainText("박신입");
});
