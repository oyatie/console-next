import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, registerEmployee } from "./flows";
import { hrAct, openCard, openHistory } from "./record";
import { staffedTenant } from "./setup-flows";
import { reasonChip } from "./helpers/lifecycle";
import { koMonthDay, reasonBox, sheet, todayPreset, fillDate } from "./sheet";

// LIFE lane (BW-11/12/13): a record is pinned to the version read, the latest change in force is corrected on its
// date or rescinded, a reservation of the same kind and date is replaced by name, and a renewal past the two-year
// fixed-term limit is refused with its statutory grounds.
test("lifecycle: correct and rescind the latest change, re-read a stale sheet, replace a reservation by name", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "lifev", "정정주식회사");
  await registerEmployee(admin, { name: "정정이", number: "LV-0001", position: "사원" });
  const personPath = new URL(admin.url()).pathname;
  await openHistory(admin);
  const history = admin.getByRole("region", { name: "인사 이력" });

  await hrAct(admin, "승진 처리");
  const promote = sheet(admin, "정정이 승진 처리");
  await promote.getByRole("textbox", { name: /^새 직위/ }).fill("과장");
  await todayPreset(promote).click();
  await reasonChip(promote, "정기 승진").click();
  await reasonBox(promote).fill("하반기 정기 승진");
  await promote.getByRole("button", { name: "오늘 승진 처리", exact: true }).click();
  const promoted = history.getByRole("listitem").filter({ hasText: "사원에서 과장으로" });
  await expect(promoted).toBeVisible();

  // 정정: the same kind and date, a corrected target, the original kept and marked.
  await promoted.getByRole("button", { name: "정정", exact: true }).click();
  const correct = sheet(admin, "정정이 승진 정정");
  await expect(correct).toContainText("종류와 시행일은 그대로입니다");
  await expect(correct.getByRole("textbox", { name: /^새 직위/ })).toHaveValue("과장");
  await correct.getByRole("textbox", { name: /^새 직위/ }).fill("대리");
  await reasonChip(correct, "입력 오류", "정정 사유").click();
  await expectAccessible(admin, "life: correct the latest change");
  await correct.getByRole("button", { name: /승진 정정$/ }).click();
  await expect(history.getByRole("status").filter({ hasText: "승진 기록을 정정했습니다" })).toBeVisible();
  await expect(history.getByRole("listitem").filter({ hasText: "정정됨" })).toContainText("사원에서 과장으로");
  const corrected = history.getByRole("listitem").filter({ hasText: "앞선 기록을 정정한 기록" });
  await expect(corrected).toContainText("사원에서 대리로");
  // The card's default view offers the same verbs on the change in force (trunk's ribbon had them on the person page).
  await openCard(admin);
  // The row's verbs, not the spine's 정정 view toggle (a pressed-state button in its 이력 보기 group).
  const rescindable = admin.getByRole("button", { name: "철회", exact: true });
  const change = admin.getByRole("complementary", { name: "현재 + 이력" }).getByRole("listitem").filter({ has: rescindable });
  await expect(change).toHaveCount(1); // only the change in force
  await expect(change.getByRole("button", { name: "철회", exact: true })).toBeVisible();
  await expect(change.getByRole("button", { name: "정정", exact: true })).toBeVisible();
  await openHistory(admin);

  // 철회: the latest change in force goes back; the rescission and its reason join the history.
  await corrected.getByRole("button", { name: "철회", exact: true }).click();
  const rescind = sheet(admin, "승진 철회");
  await expect(rescind).toContainText("정정이님의 기록이 승진 전으로 돌아가고");
  await rescind.getByRole("button", { name: "승진 철회", exact: true }).click(); // a check: no reason yet
  await expect(rescind).toContainText("사유 분류를 선택하십시오");
  await reasonChip(rescind, "계획 철회", "철회 사유").click();
  await expectAccessible(admin, "life: rescind the latest change");
  await rescind.getByRole("button", { name: "승진 철회", exact: true }).click();
  await expect(history.getByRole("status").filter({ hasText: "정정이님의 승진 기록을 철회했습니다" })).toBeVisible();
  await expect(history.getByRole("listitem").filter({ hasText: "기록을 철회했습니다" })).toContainText("계획 철회");
  await expect(history.getByRole("button", { name: "철회", exact: true })).toHaveCount(0); // nothing in force is left to undo
  await expect(admin.getByRole("group", { name: "소속" })).toContainText("사원");

  // Someone else records a change while the transfer sheet is open: the commit is refused and names it; reading
  // again keeps what was typed.
  await hrAct(admin, "전보");
  const transfer = sheet(admin, "정정이 전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용");
  await admin.getByRole("option", { name: /채용팀/ }).click();
  await todayPreset(transfer).click();
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("채용 업무 전담");
  const other = await admin.context().newPage();
  await go(other, personPath);
  await hrAct(other, "승진 처리");
  const elsewhere = sheet(other, "정정이 승진 처리");
  await elsewhere.getByRole("textbox", { name: /^새 직위/ }).fill("주임");
  await todayPreset(elsewhere).click();
  await reasonChip(elsewhere, "특별 승진").click();
  await reasonBox(elsewhere).fill("다른 창에서 기록");
  await elsewhere.getByRole("button", { name: "오늘 승진 처리", exact: true }).click();
  await expect(other.getByRole("region", { name: "인사 이력" }).getByRole("status")).toContainText("주임");
  await other.close();
  await transfer.getByRole("button", { name: "오늘 전보", exact: true }).click();
  const stale = transfer.getByRole("alert");
  await expect(stale).toContainText("그사이 기록이 바뀌었습니다");
  await expect(stale).toContainText("승진");
  await expectAccessible(admin, "life: a stale sheet names the change made since");
  await stale.getByRole("button", { name: /^최신 기록 다시 읽기/ }).click();
  await expect(transfer).toContainText("최신 기록을 다시 읽었습니다");
  await expect(reasonBox(transfer)).toHaveValue("채용 업무 전담");
  await transfer.getByRole("button", { name: "오늘 전보", exact: true }).click();
  await expect(history.getByRole("status").filter({ hasText: "정정이님을 채용팀으로 전보했습니다" })).toBeVisible();

  // A second transfer on a reserved date replaces that reservation by name, with the reason the history keeps.
  const on = kstDate(5);
  for (const [why, kept] of [["인사부 복귀 예정", false], ["인사부 복귀 확정", true]] as const) {
    await hrAct(admin, "전보");
    await transfer.getByRole("combobox", { name: "어디로" }).fill("인사");
    await admin.getByRole("option", { name: /인사부/ }).click();
    await fillDate(transfer, on);
    await reasonChip(transfer, "정기 인사").click();
    await reasonBox(transfer).fill(why);
    if (kept) {
      await expect(transfer).toContainText(`${koMonthDay(on)} 전보 예약을 이 내용으로 변경합니다`);
      await reasonChip(transfer, "일정 변경", "변경 사유").click();
    }
    await transfer.getByRole("button", { name: `전보 예약 · ${on.slice(5)} 시행`, exact: true }).click();
    await expect(history.getByRole("listitem").filter({ hasText: why })).toContainText("효력 예정");
  }
  await expect(history.getByRole("listitem").filter({ hasText: "인사부 복귀 예정" })).toHaveCount(0);
  await history.getByRole("button", { name: /취소된 기록 포함/ }).click();
  await expect(history.getByRole("listitem").filter({ hasText: "인사부 복귀 예정" })).toContainText("같은 날짜의 새 예약으로 바뀌었습니다");
});

test("lifecycle: a renewal past the two-year fixed-term limit is refused with its grounds; one inside it records", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "lifeft", "기간제주식회사");
  await registerEmployee(admin, { name: "기간이", number: "FT-0001", hired: kstDate(-700), contractEnd: kstDate(20) });
  await hrAct(admin, "계약 갱신");
  const renewal = sheet(admin, "기간이 계약 갱신");
  const service = renewal.getByRole("group", { name: "기간제 근속" });
  await expect(service).toContainText("기간제 누적 근속");
  await expect(service).toContainText("2년 한도 마지막 날");
  await renewal.getByRole("button", { name: /^다음 날부터 1년 · / }).click();
  await expect(renewal).toContainText("2년 한도");
  await expect(renewal).toContainText("단서 사유의 예외가 기록돼 있지 않으면 서버가 거부합니다");
  await reasonBox(renewal).fill("계약 1년 연장");
  await renewal.getByRole("button", { name: /^계약 갱신 예약 · \d{2}-\d{2} 시행$/ }).click();
  const refused = renewal.getByRole("alert");
  await expect(refused).toContainText("기간제 2년 한도를 넘습니다");
  await expect(refused).toContainText("휴직·파견 등으로 빈자리를");
  await expect(refused).toContainText("고령자(55세 이상)");
  await expectAccessible(admin, "life: renewal refused past the fixed-term limit");
  await refused.getByRole("button", { name: "새 종료일 다시 선택" }).click();
  await fillDate(renewal, kstDate(25), "새 계약 종료일");
  await renewal.getByRole("button", { name: /^계약 갱신 예약 · \d{2}-\d{2} 시행$/ }).click();
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("status")).toContainText("기간이님의 계약 갱신을");
});

// PEOPLE lane consumers (BW-17/18/22): HR corrects a record at once (a dated fact as the sole HR person, flagged for
// review); a branch manager sees their branch only and asks HR for a correction, which HR applies with a reason.
test("people: HR corrects a record", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(240_000); // a tenant and two corrections
  const { admin } = await staffedTenant(browser, "lifebr", "지점요청주식회사");
  await registerEmployee(admin, { name: "요청이", number: "BR-0001", unit: "채용팀" });

  // A contact fact is fixed in place (바로 수정); it reads back in the domestic form, masked by default.
  await admin.getByRole("button", { name: "휴대전화 수정" }).click();
  const phone = admin.getByRole("textbox", { name: "휴대전화" });
  await phone.fill("010-1234-0002");
  await phone.press("Enter");
  await expect(admin.getByRole("status").filter({ hasText: "저장했습니다" })).toBeVisible();
  await expect(admin.getByRole("region", { name: "인적사항" })).toContainText("010-••••-0002");
  await expectAccessible(admin, "people: correct a record");
  // A dated fact needs a second person when one holds the grant; as the sole HR person it applies with a review flag.
  await admin.getByRole("button", { name: "입사일 수정", exact: true }).click();
  const fix = sheet(admin, /입사일 정정/);
  await fix.getByRole("textbox", { name: "입사일" }).fill(kstDate(-1));
  await fix.getByRole("radiogroup", { name: /왜 정정합니까/ }).getByText("원본 서류와 다름", { exact: true }).click();
  await fix.getByRole("button", { name: "정정 요청", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "검토 표시" })).toBeVisible();

});

// governance-01 (no preset roles): this half invited the person as the legacy 「관리자」 title and relied on its
// title-implied 지점 roster («내 지점에 속한 직원만 보입니다») and 변경 요청 path. A 부서장/사업장 manager account returns
// with a tenant role over a 사업장 (decision #18: managers sign in after the pilot); its body is at mvp 825e921a,
// life.spec.ts lines 156-201. Owner: EMP-A (lane-corrections, UX-R1 ACCESS ask).
test.fixme("people: a 사업장 manager asks HR for a change, which HR applies", { tag: "@hr" }, async () => {});

