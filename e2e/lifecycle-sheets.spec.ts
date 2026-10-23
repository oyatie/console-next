import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { koDate, kstDate, registerEmployee } from "./flows";
import { hrAct, openHistory } from "./record";
import { staffedTenant } from "./setup-flows";
import { koMonthDay, reasonBox, sheet, todayPreset, fillDate } from "./sheet";
import { reasonChip } from "./helpers/lifecycle";
import { sent } from "./chaos";
import { expectComposer } from "./helpers/composer";

test("saving an incomplete lifecycle draft restores its fields without recording an action", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "lcsdraft", "임시작성주식회사");
  await registerEmployee(admin, { name: "작성이", number: "LD-0001" });
  const writes = sent(admin, /\/lifecycle-events$/);
  await hrAct(admin, "전보");
  const transfer = sheet(admin, "작성이 전보");
  await reasonBox(transfer).fill("작성 중인 전보 사유");
  await transfer.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(transfer).toBeHidden();
  expect(writes.count()).toBe(0);
  await hrAct(admin, "전보");
  await expect(transfer).toContainText("작성하던 내용을 불러왔습니다");
  await expect(reasonBox(transfer)).toHaveValue("작성 중인 전보 사유");
  await expectAccessible(admin, "lifecycle: restored incomplete draft");
  expect(writes.count()).toBe(0);
});

// Lifecycle sheets when the schedule is in the way: a leave today would break a scheduled transfer, so the server
// refuses it and names the reservation; withdrawing that one is a detour that comes back to the leave with what was
// typed. A transfer offered only now while a leave is scheduled can only take dates before that leave.
test("lifecycle sheets: a schedule conflict names the reservation, its withdrawal returns to the draft", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "lcsco", "예약충돌주식회사");
  const c = clickCounter();
  await registerEmployee(admin, { name: "충돌이", number: "LC-0001" });
  await openHistory(admin);
  const history = admin.getByRole("region", { name: "인사 이력" });

  const move = kstDate(10);
  await hrAct(admin, "전보");
  const transfer = sheet(admin, "충돌이 전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용");
  await admin.getByRole("option", { name: /채용팀/ }).click();
  await fillDate(transfer, move);
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("채용팀 합류");
  await transfer.getByRole("button", { name: "전보 1명 예약", exact: true }).click();
  await expect(history.getByText(/충돌이를 채용팀으로 전보하도록 예약했습니다/)).toBeVisible();
  await expect(history.getByRole("button", { name: "접수 번호 복사" })).toBeVisible();

  // A leave from today would leave the transfer unable to apply on its date: refused, with the reservation named.
  await hrAct(admin, "휴직 처리", c.click);
  const leave = sheet(admin, "충돌이 휴직 처리");
  await c.click(leave.getByText("개인 사유", { exact: true }));
  await c.click(todayPreset(leave));
  await reasonBox(leave).fill("개인 사정");
  await c.click(leave.getByRole("button", { name: "휴직 1명 반영", exact: true }));
  const refused = leave.getByRole("alert");
  await expect(refused).toContainText("예약된 기록과 맞지 않습니다");
  await expect(refused).toContainText(`${koMonthDay(move)}`);
  await expect(refused).toContainText("전보 예약 —");
  // 「그 예약 보기」 closes the sheet and puts focus on that reservation in the history; the draft waits.
  await refused.getByRole("button", { name: "그 예약 보기" }).click();
  await expect(leave).toBeHidden();
  await expect(history.getByRole("listitem").filter({ hasText: "채용팀 합류" })).toBeFocused();
  await hrAct(admin, "휴직 처리");
  await expect(leave).toContainText("작성하던 내용을 불러왔습니다");
  await leave.getByRole("button", { name: "휴직 1명 반영", exact: true }).click();
  await expect(refused).toContainText("예약된 기록과 맞지 않습니다");
  await expectAccessible(admin, "lifecycle: schedule conflict names the reservation");

  // Withdrawing it is a detour: the receipt leads back to the leave, which kept what was typed.
  await c.click(refused.getByRole("button", { name: "그 예약 취소" }));
  const cancel = sheet(admin, "전보 예약 취소");
  await cancel.getByRole("textbox", { name: /^취소 사유/ }).fill("휴직이 먼저 확정됨");
  await c.click(cancel.getByRole("button", { name: "전보 1명 취소" }));
  await c.click(history.getByRole("button", { name: "휴직 처리 작성으로 돌아가기" }));
  await expect(leave).toContainText("작성하던 내용을 불러왔습니다");
  await expect(reasonBox(leave)).toHaveValue("개인 사정");
  await c.click(leave.getByRole("button", { name: "휴직 1명 반영", exact: true }));
  await expect(history.getByText(/충돌이를 휴직 처리했습니다/)).toBeVisible();
  expect(c.done("leave through one schedule conflict (base 4 with 발령 + 1 type + 1 date + 4 for the detour)")).toBeLessThanOrEqual(10);

  // Back from leave on a later date; a transfer is offered now only, so it must come before that return.
  const back = kstDate(20);
  await hrAct(admin, "복직 처리");
  const ret = sheet(admin, "충돌이 복직 처리");
  await fillDate(ret, back);
  await reasonBox(ret).fill("복귀 예정");
  await ret.getByRole("button", { name: "복직 1명 예약", exact: true }).click();
  await expect(history.getByText(/충돌이를 복직 처리하도록 예약했습니다/)).toBeVisible();
  // On leave until then: a transfer is not offered now, only after the return (from the day after it).
  await hrAct(admin, "전보");
  await expect(transfer).toContainText(`${koMonthDay(back)} 복직 예약 뒤 날짜만`);
  await expect(todayPreset(transfer)).toHaveCount(0);
  await expectAccessible(admin, "lifecycle: a transfer bounded after the scheduled return");
});

// A lost response (the server recorded it, the answer never arrived): the sheet freezes and only asks whether it was
// recorded. The record command reads its durable outcome and history; cancellation reads history directly.
// Neither verification sends the command again (challenge C18).
test("lifecycle sheets: a lost response freezes the sheet until it is checked, and nothing is recorded twice", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "lclost", "응답유실주식회사");
  await registerEmployee(admin, { name: "유실이", number: "LL-0001" });
  await openHistory(admin);
  const history = admin.getByRole("region", { name: "인사 이력" });
  /** Lets the next POST to `path` reach the server, then drops its answer (or, with `reach: false`, drops the request). */
  const loseNext = async (path: RegExp, reach = true) => {
    let lost = false;
    await admin.route(path, async (r) => {
      if (lost || r.request().method() !== "POST") return r.continue();
      lost = true;
      if (reach) await r.fetch();
      await r.abort("connectionreset");
    });
  };

  await loseNext(/\/lifecycle-events$/);
  const writes = sent(admin, /\/lifecycle-events$/);
  await hrAct(admin, "전보");
  const transfer = sheet(admin, "유실이 전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용");
  await admin.getByRole("option", { name: /채용팀/ }).click();
  await todayPreset(transfer).click();
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("응답 유실 확인");
  await transfer.getByRole("button", { name: "전보 1명 반영", exact: true }).click();
  await expect(transfer).toContainText("응답을 받지 못해 기록됐는지 모릅니다");
  await expect(transfer.getByRole("button", { name: "전보 1명 반영", exact: true })).toHaveCount(0);
  await expectAccessible(admin, "lifecycle: a lost response being checked");
  await admin.unroute(/\/lifecycle-events$/);
  await transfer.getByRole("button", { name: "기록됐는지 확인" }).click();
  await expect(history.getByRole("status").filter({ hasText: "유실이님을 채용팀으로 전보했습니다" })).toBeVisible();
  await expect(history.getByRole("listitem").filter({ hasText: "응답 유실 확인" })).toHaveCount(1);
  expect(writes.count()).toBe(1);

  const later = kstDate(5);
  await hrAct(admin, "전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("인사");
  await admin.getByRole("option", { name: /인사부/ }).click();
  await fillDate(transfer, later);
  await reasonChip(transfer, "정기 인사").click();
  await reasonBox(transfer).fill("인사부 복귀 예약");
  await transfer.getByRole("button", { name: "전보 1명 예약", exact: true }).click();
  const reserved = history.getByRole("listitem").filter({ hasText: "인사부 복귀 예약" });
  await expect(reserved).toContainText("효력 예정");

  // The withdrawal never reached the server: the check says so and the form unlocks for another try.
  await loseNext(/\/cancel$/, false);
  await reserved.getByRole("button", { name: "전보 예약 취소" }).click();
  const cancel = sheet(admin, "전보 예약 취소");
  await cancel.getByRole("textbox", { name: /^취소 사유/ }).fill("계획 변경");
  await cancel.getByRole("button", { name: "전보 1명 취소" }).click();
  // A refused history read cannot use the cached reservation to resolve the lost cancellation.
  await admin.route(/\/lifecycle-events$/, (r) => r.request().method() === "GET"
    ? r.fulfill({ status: 403, json: { code: "forbidden", message: "denied" } }) : r.continue());
  await cancel.getByRole("button", { name: "기록됐는지 확인" }).click();
  await expect(cancel.getByRole("button", { name: "기록됐는지 확인" })).toBeEnabled();
  await expect(cancel.getByText("취소는 기록되지 않았습니다", { exact: false })).toHaveCount(0);
  await expect(cancel.getByRole("button", { name: "전보 1명 취소", exact: true })).toHaveCount(0);
  await admin.unroute(/\/lifecycle-events$/);
  await cancel.getByRole("button", { name: "기록됐는지 확인" }).click();
  await expect(cancel).toContainText("취소는 기록되지 않았습니다");
  await admin.unroute(/\/cancel$/);
  // Recorded this time, but the answer is lost: reading the history back shows my withdrawal, so it is done.
  await loseNext(/\/cancel$/);
  await cancel.getByRole("button", { name: "전보 1명 취소" }).click();
  await cancel.getByRole("button", { name: "기록됐는지 확인" }).click();
  await expect(history.getByRole("status").filter({ hasText: "유실이님의 전보 예약을 취소했습니다" })).toBeVisible();
  await expect(cancel).toBeHidden();
});
