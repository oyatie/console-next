import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { clickCounter } from "./clicks";
import { withLifecycleDate } from "./clock";
import { go, kstDate, koDate, registerEmployee } from "./flows";
import { cardVerbs, expectNoHrActs, openCard, openHistory } from "./record";
import { staffedTenant } from "./setup-flows";
import { signOff } from "./sheet";
import { koDay } from "./dates";
import { holdRead } from "./helpers/read";

const head = (page: Page, name: string) => page.getByRole("heading", { name: new RegExp(name), level: 1 }).locator("..");
// On the record the exit card sits inside the 휴직·퇴직 section (both named for 퇴직): the inner one is the exit card.
const exitPanel = (page: Page) => page.getByRole("region", { name: "퇴직" }).last();

/** Report the exit (in a side sheet over the record) and confirm it as HR (the confirmation exits the employee). */
async function reportAndConfirm(admin: Page, c: ReturnType<typeof clickCounter>, reason: string, opts: { probe?: boolean } = {}) {
  await c.click(admin.getByRole("button", { name: "퇴직 보고" }));
  const sheet = admin.getByRole("dialog");
  await expect(sheet).toContainText("그 전까지 재직 상태는 바뀌지 않습니다");
  if (opts.probe) {
    // The exit date has no default; committing without it names what is missing and focuses it (not a journey click).
    await sheet.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
    await expect(sheet).toContainText("2개 항목을 채워야 합니다");
    await expect(sheet.getByRole("textbox", { name: /^마지막 근무일/ })).toBeFocused();
    await expectAccessible(admin, "J5: report sheet with missing fields");
  }
  await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(0));
  await sheet.getByLabel("퇴직 경위").fill(reason);
  await sheet.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await c.click(sheet.getByRole("button", { name: "퇴직 보고 1명 반영" }));
  await expect(exitPanel(admin)).toContainText("보고됨");
  await c.click(exitPanel(admin).getByRole("button", { name: "인사 확인하고 퇴직 처리" }));
  await confirmAsHr(admin, c, opts);
  await expect(exitPanel(admin)).toContainText("인사 확인됨");
  await expect(exitPanel(admin).getByRole("button", { name: "퇴직 취소" })).toHaveCount(0);
}

/** HR confirmation needs all four statements, each ticked on its own; the server refuses it otherwise. */
async function confirmAsHr(admin: Page, c: ReturnType<typeof clickCounter>, opts: { probe?: boolean } = {}) {
  const dialog = admin.getByRole("dialog");
  const acks = dialog.getByRole("group", { name: "확인 사항" });
  const commit = dialog.getByRole("button", { name: /퇴직 1명 (반영|예약)/ });
  await expect(acks).toContainText("퇴직금·연차 정산 대상임을 확인했습니다");
  await expect(acks.getByRole("checkbox")).toHaveCount(4);
  if (opts.probe) {
    // It applies the exit now (C21: red), and it is never a dead button: pressing it with the statements unticked says how many are left and focuses the first.
    await expect(commit).toHaveClass(/btn--danger/);
    await commit.click();
    await expect(dialog).toContainText("4개 항목을 채워야 합니다");
    await expect(acks.getByRole("checkbox").first()).toBeFocused();
  }
  await signOff(acks, c.click);
  const ends = opts.probe ? await holdRead(admin, `**/api/v1/employees/${new URL(admin.url()).pathname.split("/").at(-1)}/end-options`) : null;
  await c.click(commit);
  if (ends) {
    await ends.requested;
    try {
      await expectAccessible(admin, "J5: confirmation waits for record reads");
      await expect(dialog).toBeVisible();
      await expect(commit).toBeDisabled();
    } finally {
      await ends.release();
    }
  }
  await expect(dialog).toBeHidden();
}

// J5 퇴직: report → HR confirmation (the exit) → HQ confirmation (here by someone else) → settlement approval;
// a rejection after HR confirmation reverses the exit.
test("J5 exit case: two-person confirmation, settlement submission, and a rejection that reverses the exit", { tag: ["@hr", "@clock"] }, async ({ browser }) => {
  const { admin, exec } = await staffedTenant(browser, "j5co", "퇴직주식회사");
  const c = clickCounter();

  // 1. Report and HR-confirm: the employee is exited at once; HQ confirmation must be someone else.
  await registerEmployee(admin, { name: "강퇴직", number: "J5-0001", hired: "2024-03-04" });
  await expectAccessible(admin, "J5: employee page with the exit panel");
  await reportAndConfirm(admin, c, "개인 사정으로 사직", { probe: true });
  expect(c.done("J5 report + HR confirm")).toBeLessThanOrEqual(8);
  await expect(head(admin, "강퇴직").getByText("퇴직", { exact: true })).toBeVisible();
  // decisions #26 (approval.policy.exit = none, the default): the HR confirmer may finish the HQ tier too; here the
  // executive takes it from Home. regression (W09): the same person is no longer told to find someone else.
  await expect(exitPanel(admin).getByRole("button", { name: "본사 퇴직 확인" })).not.toHaveAttribute("aria-disabled", "true");
  await expect(exitPanel(admin)).not.toContainText("인사 확인자는 본사 확인을 할 수 없습니다");
  await openHistory(admin);
  await expect(admin.getByRole("region", { name: "인사 이력" })).toContainText("강퇴직을 퇴직 처리했습니다");
  await expect(admin.getByRole("region", { name: "인사 이력" })).toContainText("개인 사정으로 사직"); // the reported reason, not a system note
  await expectNoHrActs(admin); // an exited employee has no HR actions
  await expectAccessible(admin, "J5: HR-confirmed exit");
  await openCard(admin);

  // 2. The executive confirms as HQ, straight from Home's exit queue.
  await exec.goto("/");
  const queue = exec.getByRole("region", { name: "업무함", exact: true }).getByRole("listitem").filter({ hasText: "강퇴직" }).filter({ has: exec.getByRole("link", { name: "본사 퇴직 확인", exact: true }) });
  await expect(queue).toContainText("강퇴직");
  await expectAccessible(exec, "J5: Home exit queue");
  await c.click(queue.getByRole("link", { name: "본사 퇴직 확인", exact: true }));
  // The case page puts the HQ step's form inline at the current step and focuses it.
  const hq = exec.getByRole("region", { name: /지금/ });
  await expect(hq.getByRole("heading", { name: "지금 · 본사 확인" })).toBeFocused();
  await expect(hq).toContainText("사유를 남겨 반려할 수 있으며");
  // The resolving record discloses the reason and previous confirmer before the decision.
  await expect(hq).toContainText("개인 사정으로 사직");
  await expect(exec.getByRole("main")).toContainText("인사 확인자");
  await expectAccessible(exec, "J5: HQ confirmation at the current step");
  await c.click(hq.getByRole("button", { name: "퇴직 본사 확인 1명 반영" }));
  await expect(exitPanel(exec)).toContainText("본사 확인됨");
  await expectAccessible(exec, "J5: exit case page (HQ confirmed)");
  await expect(exitPanel(exec)).toContainText("이임원님이 본사에서 퇴직을 확인했습니다");
  expect(c.done("J5 HQ confirm from Home")).toBeLessThanOrEqual(2);

  // 3. HR prepares the settlement from Home and submits it for approval.
  await admin.goto("/");
  await c.click(admin.getByRole("region", { name: "업무함", exact: true }).getByRole("listitem").filter({ hasText: "강퇴직" }).getByRole("link", { name: "퇴직 정산 결재 준비", exact: true }));
  const settle = admin.getByRole("region", { name: /지금/ });
  await settle.getByLabel("평균임금 산정 시작일").fill(kstDate(-91));
  await settle.getByLabel("평균임금 산정 종료일").fill(kstDate(0));
  await settle.getByLabel("산정 기간 총일수").fill("92");
  await settle.getByLabel("기간 임금 총액").fill("9600000");
  await settle.getByLabel("월 통상임금").fill("3200000");
  await expectAccessible(admin, "J5: settlement form at the current step");
  // Submission is final, so it waits, with why beside it, until the server's figures are on screen.
  const submit = settle.getByRole("button", { name: "퇴직 정산 1명 결재 요청" });
  await expect(submit).toHaveAttribute("aria-disabled", "true");
  await expect(settle).toContainText("초안을 저장해 계산한 뒤 상신할 수 있습니다");
  // C21: computing is the next move (blue); submitting is final (red).
  await expect(settle.getByRole("button", { name: "퇴직 정산 1명 계산" })).toHaveClass(/btn--primary/);
  await expect(submit).toHaveClass(/btn--danger/);
  await c.click(settle.getByRole("button", { name: "퇴직 정산 1명 계산" }));
  await expect(settle).toContainText(/퇴직금 산정액\D*[\d,]+원/);
  await expect(settle).toContainText("검증 전 초안");
  // The figures show once: beside the form, not again in the facts column.
  await expect(admin.getByRole("region", { name: "산정 결과" })).toHaveCount(1);
  await expect(submit).not.toHaveAttribute("aria-disabled");
  await expectAccessible(admin, "J5: settlement form with the server's figures");
  await c.click(submit);
  await expect(exitPanel(admin)).toContainText("상신됨");
  await expect(exitPanel(admin)).toContainText("퇴직 정산 결재를 상신했습니다");
  await expect(exitPanel(admin)).toContainText(/퇴직금 산정액\D*[\d,]+원/);
  await expect(exitPanel(admin).getByRole("group", { name: "퇴직 조치" })).toHaveCount(0); // submitted is final
  expect(c.done("J5 settlement draft, review and submit")).toBeLessThanOrEqual(3);

  // Every case, at any step, is reachable from the exit list; the server filters it by status and counts it.
  await c.click(exec.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "퇴직", exact: true }));
  const list = exec.getByRole("grid", { name: "퇴직 관리" });
  const chips = exec.getByRole("group", { name: "상태" });
  await expect(list).toContainText("강퇴직");
  await expectAccessible(exec, "J5: exit list");
  // Each status chip carries the server's count and is the filter.
  await expect(chips.getByRole("button", { name: /^진행 중/ })).toHaveText(/^진행 중\s*0$/);
  await c.click(chips.getByRole("button", { name: /^진행 중/ }));
  await expect(exec.getByText("조건에 맞는 퇴직 건이 없습니다")).toBeVisible();
  await expectAccessible(exec, "J5: exit list filtered to nothing");
  await c.click(chips.getByRole("button", { name: /^종결/ }));
  await expect(chips.getByRole("button", { name: /^종결/ })).toHaveAttribute("aria-pressed", "true");
  await expect(list).toContainText("강퇴직");
  await expect(exec.getByText("퇴직 건 1건")).toBeVisible();
  c.done("J5 exit list");

  // The roster hides exited people by default; the status filter shows them.
  await go(admin, "/people");
  await expect(admin.getByRole("rowheader", { name: "강퇴직", exact: true })).toHaveCount(0);
  await admin.getByRole("group", { name: "상태" }).getByRole("button", { name: /^퇴직 · 3년 보관/ }).click();
  await expect(admin.getByRole("row", { name: /강퇴직/ })).toContainText("퇴직");

  // 4. A second exit, rejected by the executive after HR confirmation: the exit is reversed.
  await registerEmployee(admin, { name: "문반려", number: "J5-0002", hired: "2025-01-06" });
  const employeePage = admin.url();
  await reportAndConfirm(admin, c, "무단 결근 지속");
  c.done("J5 second report + HR confirm");
  await exec.goto("/");
  // The case page offers HQ confirmation and rejection side by side.
  await c.click(exec.getByRole("region", { name: "업무함", exact: true }).getByRole("listitem").filter({ hasText: "문반려" }).getByRole("link", { name: "본사 퇴직 확인", exact: true }));
  await c.click(exitPanel(exec).getByRole("button", { name: "퇴직 철회" }));
  const reject = exec.getByRole("dialog", { name: "퇴직 철회" });
  await expect(reject).toContainText("퇴직 전 상태로 복원");
  await reject.getByLabel("철회 사유").fill("결근 사유 확인됨");
  await expectAccessible(exec, "J5: reject dialog");
  await c.click(reject.getByRole("button", { name: "퇴직 1명 철회" }));
  await expect(exitPanel(exec)).toContainText("반려됨");
  await expect(exitPanel(exec)).toContainText("이임원님이 퇴직을 반려했습니다");
  expect(c.done("J5 reject from Home (reverses the exit)")).toBeLessThanOrEqual(3);

  await admin.goto(employeePage);
  await expect(head(admin, "문반려").getByText("재직", { exact: true })).toBeVisible();
  await openHistory(admin);
  await expect(admin.getByRole("region", { name: "인사 이력" })).toContainText("이임원님이 문반려의 퇴직 처리를 되돌렸습니다");
  await expect(cardVerbs(admin).getByRole("button", { name: "발령" })).toBeVisible();

  // 5. An exit confirmed ahead of its date is scheduled: the employee stays employed and the record
  // says when they leave; rejecting the case with a reason before then withdraws it.
  await registerEmployee(admin, { name: "예정퇴직", number: "J5-0003", hired: "2025-02-03" });
  const exitOn = kstDate(10);
  await c.click(admin.getByRole("button", { name: "퇴직 보고" }));
  await admin.getByRole("textbox", { name: /^마지막 근무일/ }).fill(exitOn);
  await admin.getByLabel("퇴직 경위").fill("계약 만료 예정");
  await admin.getByRole("dialog").getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await c.click(admin.getByRole("dialog").getByRole("button", { name: "퇴직 보고 1명 반영" }));
  // A report withdrawal left open must follow another tab's HR confirmation through SSE, even while sheets hold list refreshes.
  const otherHr = await admin.context().newPage();
  await otherHr.goto(new URL(admin.url()).pathname);
  await exitPanel(otherHr).getByRole("button", { name: "퇴직 취소" }).click();
  const staleCancel = otherHr.getByRole("dialog", { name: "퇴직 취소" });
  await staleCancel.getByLabel("취소 사유").fill("담당자 확인 중");
  await c.click(exitPanel(admin).getByRole("button", { name: "인사 확인하고 퇴직 처리" }));
  await expect(admin.getByRole("dialog")).toContainText(`${koDate(exitOn)}자로 퇴직 처리하도록 예약합니다`);
  // A scheduled exit can still be withdrawn, so its button is blue and names the date.
  await expect(admin.getByRole("dialog").getByRole("button", { name: "퇴직 1명 예약" })).toHaveClass(/btn--primary/);
  await expectAccessible(admin, "J5: HR confirmation of a future exit");
  await confirmAsHr(admin, c);
  await expect(staleCancel).toContainText("이 조치는 지금 할 수 없습니다");
  await expect(staleCancel.getByRole("button", { name: "퇴직 취소" })).toHaveCount(0);
  await expect(staleCancel).not.toContainText("아직 퇴직 처리 전이라 재직 상태는 그대로입니다");
  await expect(staleCancel).toContainText("담당자 확인 중");
  await staleCancel.getByRole("button", { name: "닫기", exact: true }).click();
  await otherHr.close();
  await expect(exitPanel(admin)).toContainText("효력 예정");
  await expect(exitPanel(admin)).toContainText(`${koDate(exitOn)}에 퇴직 처리가 반영됩니다`);
  await expect(head(admin, "예정퇴직").getByText("재직", { exact: true })).toBeVisible();
  await expect(head(admin, "예정퇴직").getByText("효력 예정")).toBeVisible();
  await expect(admin.getByRole("group", { name: "다음 일정" })).toContainText(`${koDate(exitOn)} 퇴직 예정`);
  await expect(admin.getByRole("region", { name: "다음 기록" })).toContainText(`퇴직 · ${koDay(exitOn)}`);
  await expectAccessible(admin, "J5: scheduled exit");
  expect(c.done("J5 report + confirm a future exit")).toBeLessThanOrEqual(8);

  // While the executive has the HQ step open with a memo typed, HR rejects the case: on the next read the form
  // stays, read-only, saying who did it, and the memo stays readable (not a journey click).
  const caseHref = await exitPanel(admin).getByRole("link", { name: "퇴직 건 열기" }).getAttribute("href");
  await exec.goto(caseHref!);
  await expect(exec.getByRole("button", { name: "퇴직 취소" })).toBeVisible();
  const open = exec.getByRole("region", { name: /지금/ });
  await open.getByLabel("확인 메모").fill("계약 종료 서류 확인 중");

  await expect(exitPanel(admin).getByRole("button", { name: "퇴직 취소" })).toBeVisible();
  await c.click(exitPanel(admin).getByRole("button", { name: "퇴직 취소" }));
  const withdraw = admin.getByRole("dialog", { name: "퇴직 취소" });
  await expect(withdraw).toContainText(`${koDate(exitOn)}자 퇴직 예약을 거둡니다`);
  await withdraw.getByRole("button", { name: "퇴직 1명 취소" }).click();
  await expect(withdraw.getByRole("textbox", { name: /^취소 사유/ })).toBeFocused();
  await withdraw.getByLabel("취소 사유").fill("계약 연장 합의");
  await c.click(withdraw.getByRole("button", { name: "퇴직 1명 취소" }));
  await expect(exitPanel(admin)).toContainText("반려됨");
  await expect(head(admin, "예정퇴직").getByText("효력 예정")).toHaveCount(0);
  expect(c.done("J5 withdraw the scheduled exit")).toBeLessThanOrEqual(2);

  // The event stream says the case changed, and the open page re-reads it (decision #27: nothing polls).
  await expect(open).toContainText("이미 처리했습니다", { timeout: 45_000 });
  await expect(open).toContainText("계약 종료 서류 확인 중");
  await expect(open.getByRole("button", { name: "퇴직 본사 확인 1명 반영" })).toHaveCount(0);
  await expectAccessible(exec, "J5: a step someone else took while the form was open");
  await open.getByRole("button", { name: "지금 단계 보기" }).click();
  await expect(exitPanel(exec)).toContainText("반려됨");

  // 6. A scheduled exit that is not withdrawn applies on its date (a background run, on a date the test moves the
  // backend's apply clock to): the employee is exited then, and the history says when it took effect.
  await registerEmployee(admin, { name: "날짜퇴직", number: "J5-0004", hired: "2025-03-03" });
  const leaveOn = kstDate(4);
  await c.click(admin.getByRole("button", { name: "퇴직 보고" }));
  await admin.getByRole("textbox", { name: /^마지막 근무일/ }).fill(leaveOn);
  await admin.getByLabel("퇴직 경위").fill("이직 확정");
  await admin.getByRole("dialog").getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await c.click(admin.getByRole("dialog").getByRole("button", { name: "퇴직 보고 1명 반영" }));
  await c.click(exitPanel(admin).getByRole("button", { name: "인사 확인하고 퇴직 처리" }));
  await confirmAsHr(admin, c);
  await expect(exitPanel(admin)).toContainText("효력 예정");
  c.done("J5 schedule an exit");
  await withLifecycleDate(leaveOn, async () => {
    // Pages keep what they read for 30 s: reload (a few times at most; the session refresh is rate-limited).
    await expect(async () => {
      // Reload only a loaded page: a reload during its session refresh replays the rotated token, which signs out.
      await expect(head(admin, "날짜퇴직")).toBeVisible();
      await admin.reload();
      await expect(head(admin, "날짜퇴직").getByText("퇴직", { exact: true })).toBeVisible({ timeout: 1_000 });
    }).toPass({ intervals: [2_000, 3_000, 5_000], timeout: 30_000 });
  });
  await openHistory(admin);
  await expect(admin.getByRole("region", { name: "인사 이력" })).toContainText(`날짜퇴직이 ${koDate(leaveOn)}자로 퇴직했습니다 (예약: `);
  await openCard(admin);
  await expect(exitPanel(admin)).not.toContainText("효력 예정");
  // The head says when the person left and leads to the case (trunk's person head did; regression).
  await expect(admin.getByRole("main")).toContainText(`${koDate(leaveOn)}에 퇴직했습니다`);
  await expect(admin.getByRole("button", { name: "퇴직 건 보기" }).first()).toBeVisible();
  await expectNoHrActs(admin);
  await expectAccessible(admin, "J5: a scheduled exit applied on its date");

  // Phone width: the exit list (filter and total) and an exit case page never scroll sideways.
  await atPhoneWidth(admin, async () => {
    await go(admin, "/people/exits");
    await expect(admin.getByRole("grid", { name: "퇴직 관리" })).toContainText("날짜퇴직");
    await fits(admin, "J5: exit list");
    await admin.getByRole("link", { name: "날짜퇴직", exact: true }).click();
    await expect(admin.getByRole("heading", { name: /날짜퇴직 퇴직/, level: 1 })).toBeVisible();
    // The case page leads back to the list it came from and on to the employee's record.
    await expect(admin.getByRole("link", { name: "퇴직 관리" })).toBeVisible();
    await expect(admin.getByRole("link", { name: "날짜퇴직의 인사카드 열기" })).toBeVisible();
    await fits(admin, "J5: exit case page");
    await expectAccessible(admin, "J5: exit case page at 390px");
  });
});
