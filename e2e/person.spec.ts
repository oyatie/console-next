import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { clickCounter } from "./clicks";
import { go, koDate, kstDate, registerEmployee } from "./flows";
import { hrAct, openHistory } from "./record";
import { registerBranch, staffedTenant } from "./setup-flows";
import { koDay } from "./dates";
import { chooseWorkbook } from "./helpers/import";
import { workbook } from "./helpers/import-layouts";
import { reasonChip } from "./helpers/lifecycle";
import { koMonthDay, reasonBox, said, sheet, todayPreset, fillDate } from "./sheet";

/** The bearer the page itself sends (kept in memory by the app), to change the record behind the page's back. */
function bearerOf(page: Page) {
  let bearer = "";
  page.on("request", (r) => {
    if (!r.url().includes("/api/v1/")) return;
    // A request still in flight when the test ends cannot read its headers any more; it carries nothing we need.
    r.allHeaders().then((h) => { if (h.authorization) bearer = h.authorization; }, () => {});
  });
  return () => bearer;
}

// The employee page (design §3): the history reads by effective date, a reservation can be changed or withdrawn,
// verbs say why they are unavailable, an act the server does not offer opens nothing, and a home-branch write
// that lost a race shows mine against current.
test("employee page: effective-date history, change a reservation, home-branch conflict", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin, exec } = await staffedTenant(browser, "pgco", "기록주식회사");
  const bearer = bearerOf(admin);
  const c = clickCounter();
  // Registered while the tenant has one branch (it becomes the home branch); a second opens for the conflict in 4.
  await registerEmployee(admin, { name: "정기록", number: "PG-0001", hired: "2025-03-03", position: "사원" });
  const personPath = new URL(admin.url()).pathname;
  // A 사업장 brings its own branch (regions retired, decisions #18): a second one, from the 법인's record.
  await registerBranch(admin, "기록주식회사", "부산 지점", "0008512347");
  await go(admin, personPath);
  const head = admin.getByRole("heading", { name: /정기록/, level: 1 }).locator("..");
  const place = admin.getByRole("group", { name: "소속" });
  await expect(place).toContainText("인사부");
  await expect(place).toContainText(/사원 · 입사 2025\. 03\. 03\. · 근속 \d+년 \d+개월/);
  const next = admin.getByRole("group", { name: "다음 일정" });
  await expect(next).toContainText("예정된 발령 없음");
  // Trunk's 다음 기록 box stays on the card (regression: the card dropped it once).
  await expect(admin.getByRole("region", { name: "다음 기록" })).toContainText("예정된 기록이 없습니다");
  // The mobile number reads in the domestic form for a manager (masked by default), never as the raw E.164 value; a
  // reader without manage is told the personal details are closed to them.
  const personal = admin.getByRole("region", { name: "인적사항" });
  await expect(personal).toContainText("010-••••-6789");
  await expect(personal).not.toContainText("+82");
  await openHistory(admin);
  const history = admin.getByRole("region", { name: "인사 이력" });
  await expect(history.getByRole("listitem")).toHaveText([/직원 등록/]); // the system comment reads as the act
  await go(exec, personPath);
  await expect(exec.getByText(/인적사항.*열람 권한이 없습니다/)).toBeVisible();

  // 1. A transfer today, then a promotion back-dated three weeks: the promotion sits at its date, below the
  // transfer, although it was recorded after it. The new record takes focus and carries the receipt.
  await hrAct(admin, "전보");
  const transfer = sheet(admin, "정기록 전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용");
  await admin.getByRole("option", { name: /채용팀/ }).click();
  await todayPreset(transfer).click();
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("채용 업무 전담");
  await transfer.getByRole("button", { name: "오늘 전보", exact: true }).click();
  await expect(history).toContainText("정기록을 인사부에서 채용팀으로 전보했습니다");
  await hrAct(admin, "승진 처리");
  const promote = sheet(admin, "정기록 승진 처리");
  await promote.getByRole("textbox", { name: /^새 직위/ }).fill("대리");
  const back = kstDate(-21);
  await fillDate(promote, back);
  // A past date applies now, back-dated: red, and the sentence says so (challenge C2).
  await expect(promote).toContainText(said("정기록님을 {day}자로 소급해 사원에서 대리로 승진 처리합니다. 바로 반영됩니다. 잘못 기록했다면 인사 이력에서 정정하거나 철회합니다", back));
  await reasonChip(promote, "정기 승진").click();
  await reasonBox(promote).fill("소급 승진");
  const backdated = promote.getByRole("button", { name: `${koMonthDay(back)}자 승진 처리 (지난 날짜)`, exact: true });
  await expect(backdated).toHaveClass(/btn--danger/);
  await backdated.click();
  const promoted = history.getByRole("listitem").filter({ hasText: "소급 승진" });
  await expect(promoted).toBeFocused();
  await expect(history.getByRole("status").filter({ hasText: "정기록님을 대리로 승진 처리했습니다" })).toBeVisible();
  await expect(history.getByRole("listitem")).toHaveText([/채용팀으로 전보했습니다/, /소급 승진/, /직원 등록/]);
  await expect(history.getByRole("separator", { name: /^오늘 · / })).toBeVisible();
  await expectAccessible(admin, "employee page: history by effective date with a receipt");

  // 2. A reservation: the next box names it with its distance; changing it keeps its date and says so.
  const on = kstDate(5);
  await hrAct(admin, "전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("인사");
  await admin.getByRole("option", { name: /인사부/ }).click();
  await fillDate(transfer, on);
  await reasonChip(transfer, "정기 인사").click();
  await reasonBox(transfer).fill("인사부 복귀 예정");
  await transfer.getByRole("button", { name: `전보 예약 · ${koDate(on)} 시행`, exact: true }).click();
  await expect(next).toContainText(`${koDate(on)} 전보 예정`);
  await expect(history.getByRole("heading", { name: "예정", level: 3 })).toBeVisible();
  const reserved = history.getByRole("listitem").filter({ hasText: "인사부 복귀 예정" });
  await expect(reserved).toContainText("효력 예정");

  await c.click(reserved.getByRole("button", { name: "전보 예약 변경" }));
  const change = sheet(admin, "정기록 전보 예약 변경");
  await expect(change).toContainText(`시행일 ${koDay(on)} · 예약 그대로`);
  await expect(change).toContainText("날짜를 변경하려면 이 예약을 취소하고 새로 예약합니다");
  await expect(change.getByRole("combobox", { name: "어디로" })).toHaveValue(/인사부/); // carried from the reservation
  await reasonBox(change).fill("인사부 복귀 확정");
  // BW-11: the change names the reservation it replaces, with the reason the history keeps.
  await c.click(reasonChip(change, "일정 변경", "변경 사유"));
  await expectAccessible(admin, "employee page: change a reservation");
  const keep = change.getByRole("button", { name: `${koMonthDay(on)} 전보 예약 변경` });
  await expect(keep).toHaveClass(/btn--primary/);
  await c.click(keep);
  await expect(history.getByRole("listitem").filter({ hasText: "인사부 복귀 확정" })).toContainText("효력 예정");
  await expect(history.getByRole("listitem").filter({ hasText: "인사부 복귀 예정" })).toHaveCount(0); // replaced, hidden
  await history.getByRole("button", { name: /취소된 기록 포함/ }).click();
  await expect(history.getByRole("listitem").filter({ hasText: "인사부 복귀 예정" })).toContainText("같은 날짜의 새 예약으로 바뀌었습니다");
  // Budget: change, commit + the replacement's reason (BW-11); no statement to tick (A13).
  expect(c.done("change a reservation")).toBeLessThanOrEqual(3);

  // 3. An act the server does not offer opens nothing and says so; the page stays usable.
  await go(admin, `${personPath}?act=RETURN_FROM_LEAVE`);
  const notice = admin.getByRole("status").filter({ hasText: "이 조치는 지금 할 수 없습니다." });
  await expect(notice).toBeVisible();
  await expect(admin.getByRole("dialog")).toHaveCount(0);
  await notice.getByRole("button", { name: "알림 닫기" }).click();
  await expect(notice).toHaveCount(0);

  // A placed person's branch follows their workplace; the free branch picker is only for unplaced records.
  await expect(admin.getByRole("region", { name: "소속 지점" }).getByText("부산 지점", { exact: true })).toHaveCount(0);
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "미배치.xlsx", await workbook([{ name: "주식회사 기록주식회사", lines: [
    ["사번", "성명", "부서", "직위", "입사일", "고용형태"],
    ["PG-0002", "정미배치", "", "사원", "2025-03-03", "정규직"],
  ] }]));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await admin.getByRole("button", { name: /^명부 반영: 신규 1명/ }).click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible();
  await go(admin, "/people");
  await admin.getByRole("rowheader", { name: "정미배치", exact: true }).click();
  await admin.getByRole("complementary", { name: "직원 상세" }).getByRole("link", { name: "인사카드 열기", exact: true }).click();
  const unplacedPath = new URL(admin.url()).pathname;

  // 4. Home branch: someone else changes the record between the read and the write (twice, ending where it was).
  // The write is refused, the record is re-read, and the user keeps their pick against the current value.
  const branchCard = admin.getByRole("region", { name: "소속 지점" });
  if (!(await branchCard.innerText()).includes("현재 본사")) {
    await branchCard.getByText("본사", { exact: true }).click();
    await branchCard.getByRole("button", { name: "본사로 소속 지점 지정" }).click();
  }
  await expect(branchCard).toContainText("현재 본사");
  await branchCard.getByText("부산 지점", { exact: true }).click(); // the segmented option's label (its input is visually hidden)
  const id = unplacedPath.split("/").pop()!;
  const api = (path: string, method = "GET", data?: object) => admin.request.fetch(`/api/v1${path}`, { method, headers: { authorization: bearer() }, data });
  const branches = (await (await api("/branches")).json()) as { id: string; name: string }[];
  for (const name of ["부산 지점", "본사"]) {
    const { employee } = (await (await api(`/employees/${id}`)).json()) as { employee: { updated_at: string } };
    const put = await api(`/employees/${id}/home-branch`, "PUT", { branch_id: branches.find((b) => b.name === name)!.id, expected_updated_at: employee.updated_at });
    expect(put.ok(), await put.text()).toBe(true);
  }
  await branchCard.getByRole("button", { name: "부산 지점으로 소속 지점 지정" }).click();
  await expect(branchCard.getByRole("alert")).toContainText("확인한 뒤 1개 항목이 바뀌어 아무것도 반영하지 않았습니다");
  await expect(branchCard).toContainText("내 값");
  await expect(branchCard).toContainText("본사");
  await expectAccessible(admin, "employee page: home-branch conflict");
  await branchCard.getByText("내 값 유지", { exact: true }).click();
  await branchCard.getByRole("button", { name: "부산 지점으로 소속 지점 지정" }).click();
  await expect(branchCard).toContainText("현재 부산 지점");

  await go(admin, personPath);

  await atPhoneWidth(admin, async () => {
    await expect(head.getByText("효력 예정")).toBeVisible();
    await fits(admin, "employee page with history lanes and the rail below");
  });
});
