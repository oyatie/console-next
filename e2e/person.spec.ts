import { expect, test } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { clickCounter } from "./clicks";
import { go, koDate, kstDate, registerEmployee } from "./flows";
import { hrAct, openHistory } from "./record";
import { registerBranch, staffedTenant } from "./setup-flows";
import { koDay } from "./dates";
import { chooseWorkbook } from "./helpers/import";
import { workbook } from "./helpers/import-layouts";
import { reasonChip } from "./helpers/lifecycle";
import { reasonBox, said, sheet, todayPreset, fillDate } from "./sheet";

// The employee page (design §3): the history reads by effective date, a reservation can be changed or withdrawn,
// verbs say why they are unavailable, an act the server does not offer opens nothing, and placement comes from the assignment.
test("employee page: effective-date history, change a reservation, statutory placement", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin, exec } = await staffedTenant(browser, "pgco", "기록주식회사");
  const c = clickCounter();
  // Register in the tenant's first workplace, then add a second statutory workplace.
  await registerEmployee(admin, { name: "정기록", number: "PG-0001", hired: "2025-03-03", position: "사원" });
  const personPath = new URL(admin.url()).pathname;
  // A second workplace is added from the legal entity record.
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
  await expect(personal).toContainText("010-••••-0001");
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
  await transfer.getByRole("button", { name: "전보 1명 반영", exact: true }).click();
  await expect(history).toContainText("정기록을 인사부에서 채용팀으로 전보했습니다");
  await hrAct(admin, "승진 처리");
  const promote = sheet(admin, "정기록 승진 처리");
  await promote.getByRole("textbox", { name: /^새 직위/ }).fill("대리");
  const back = kstDate(-21);
  await fillDate(promote, back);
  // A past date applies now, back-dated, and the effect sentence says so (challenge C2).
  await expect(promote).toContainText(said("정기록님을 {day}자로 소급해 사원에서 대리로 승진 처리합니다. 바로 반영됩니다. 잘못 기록했다면 인사 이력에서 정정하거나 철회합니다", back));
  await reasonChip(promote, "정기 승진").click();
  await reasonBox(promote).fill("소급 승진");
  const backdated = promote.getByRole("button", { name: "승진 1명 반영", exact: true });
  await expect(backdated).toBeEnabled();
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
  await transfer.getByRole("button", { name: "전보 1명 예약", exact: true }).click();
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
  const keep = change.getByRole("button", { name: "전보 1명 변경", exact: true });
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

  await expect(place).toContainText("본사");
  await expect(admin.getByRole("region", { name: "재직·배치" })).toContainText("본사");
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
  const job = admin.getByRole("region", { name: "재직·배치" });
  await expect(job).toContainText("미배치");
  await expect(admin.getByRole("region", { name: "소속 지점" })).toHaveCount(0);
  await expect(admin.getByRole("button", { name: /소속 지점 지정/ })).toHaveCount(0);
  await expectAccessible(admin, "employee page: unplaced assignment");

  await go(admin, personPath);

  await atPhoneWidth(admin, async () => {
    await expect(head.getByText("효력 예정")).toBeVisible();
    await fits(admin, "employee page with history lanes and the rail below");
  });
});
