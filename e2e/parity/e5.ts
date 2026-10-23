import { expect, type Page } from "@playwright/test";
import { go, koDate, kstDate } from "../flows";
import { fillRegister, openRegistered, pressRegister, receiptOf } from "../helpers/register";
import { signOff } from "../sheet";
import { frame, shot } from "./shot";

// E5 발령 frames on the parity world after 운영 시작: the kinds menu and the sheets the server serves.

/** Opens a person's record from the roster by their exact 사번 and returns its path. */
export async function openPerson(page: Page, number: string) {
  await go(page, "/people");
  const find = page.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill(number);
  await find.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(number);
  return new URL(page.url()).pathname;
}

const act = async (page: Page, path: string, a: string) => {
  await go(page, `${path}?act=${a}`);
  await expect(page.getByRole("dialog")).toBeVisible();
};
const sheet = (page: Page) => page.getByRole("dialog");
const chip = (page: Page, group: RegExp, name: string) => sheet(page).getByRole("radiogroup", { name: group }).getByText(name, { exact: true });

export async function captureE5(page: Page) {
  let contract = "";
  // The hero: a 생산1팀 member with a transfer to 생산3팀 dated two weeks ahead.
  const hero = await openPerson(page, "10001");
  await frame(page, "E5-menu", async () => {
    await act(page, hero, "menu");
    await shot(page, "E5-menu");
    await page.keyboard.press("Escape");
  });
  await frame(page, "E5-transfer", async () => {
    await act(page, hero, "TRANSFER");
    const box = sheet(page).getByRole("combobox", { name: "어디로" });
    await box.fill("생산3팀");
    await page.getByRole("option", { name: /생산3팀/ }).click();
    await sheet(page).getByRole("textbox", { name: /^언제부터/ }).fill(kstDate(13));
    const reason = sheet(page).getByRole("radiogroup", { name: /사유 분류/ });
    if (await reason.isVisible()) await reason.getByRole("radio").first().locator("xpath=ancestor::label[1]").click();
    await sheet(page).getByRole("textbox", { name: /사유 메모|^사유/ }).fill("인력 재배치");
    await shot(page, "E5-transfer");
    await sheet(page).getByRole("button", { name: "닫기", exact: true }).last().click();
  });
  await frame(page, "E5-leave", async () => {
    const leaver = await openPerson(page, "10007");
    await act(page, leaver, "LEAVE_OF_ABSENCE");
    const kinds = sheet(page).getByRole("radiogroup").first();
    await kinds.getByRole("radio").first().locator("xpath=ancestor::label[1]").click();
    await sheet(page).getByRole("button", { name: /^다음 달 1일/ }).click();
    await sheet(page).getByRole("textbox", { name: /사유/ }).first().fill("육아휴직 신청");
    await shot(page, "E5-leave");
    await sheet(page).getByRole("button", { name: "닫기", exact: true }).last().click();
  });
  await frame(page, "E5-appoint", async () => {
    const kt = await openPerson(page, "10013");
    await act(page, kt, "APPOINT");
    // No list is seeded (#19): the ops account fills 직책 from the sheet itself (BE-EMP-UI §1), each chosen as added.
    for (const role of ["팀장 (부서장)", "파트장", "반장", "조장"]) {
      await sheet(page).getByRole("button", { name: "직책 추가" }).click();
      await sheet(page).getByRole("textbox", { name: "새 직책 이름" }).fill(role);
      await sheet(page).getByRole("button", { name: "추가", exact: true }).click();
      await expect(sheet(page).getByRole("radio", { name: role })).toBeChecked();
    }
    await sheet(page).getByRole("radiogroup", { name: /^직책/ }).getByText("팀장 (부서장)", { exact: true }).click();
    await sheet(page).getByRole("button", { name: /^다음 달 1일/ }).click();
    await sheet(page).getByRole("textbox", { name: /^사유/ }).first().fill("부서장 공석 보충");
    await shot(page, "E5-appoint");
    await sheet(page).getByRole("button", { name: "닫기", exact: true }).last().click();
  });
  await frame(page, "E5-convert", async () => {
    // A person registered through the sheet has an employment profile: a contract worker to convert and renew.
    await go(page, "/people/new");
    await fillRegister(page, { name: "조경수", unit: "생산1팀", hired: kstDate(-700), contractEnd: kstDate(30) });
    await pressRegister(page);
    await expect(receiptOf(page, "조경수")).toBeVisible();
    await openRegistered(page, "조경수");
    const path = new URL(page.url()).pathname;
    contract = path;
    await act(page, path, "EMPLOYMENT_TYPE_CHANGE");
    await chip(page, /^어떤 형태로/, "정규직").click();
    await sheet(page).getByRole("button", { name: /^계약 종료 다음 날|^다음 달 1일/ }).first().click();
    await sheet(page).getByRole("textbox", { name: /사유/ }).first().fill("기간제 2년 만료 전 전환");
    await shot(page, "E5-convert");
    await sheet(page).getByRole("button", { name: "닫기", exact: true }).last().click();
    await act(page, path, "CONTRACT_RENEWAL");
    await shot(page, "E5-renew");
    await sheet(page).getByRole("button", { name: "닫기", exact: true }).last().click();
  });
  await frame(page, "E5-return", async () => {
    const back = await openPerson(page, "10019");
    await act(page, back, "LEAVE_OF_ABSENCE");
    await sheet(page).getByRole("radiogroup").first().getByRole("radio").nth(3).locator("xpath=ancestor::label[1]").click();
    await sheet(page).getByRole("button", { name: /^오늘/ }).first().click();
    // A planned return, so the return sheet offers it as its own date (「예정대로」).
    await sheet(page).getByRole("button", { name: /^\+3개월/ }).first().click();
    await sheet(page).getByRole("textbox", { name: /사유/ }).first().fill("개인 사유");
    await sheet(page).getByRole("button", { name: /휴직/ }).last().click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await act(page, back, "RETURN_FROM_LEAVE");
    await sheet(page).getByRole("button", { name: /^예정대로/ }).click();
    await shot(page, "E5-return");
    await sheet(page).getByRole("button", { name: "닫기", exact: true }).last().click();
  });
  await frame(page, "E5-exit", async () => {
    // The contract worker with a transfer reserved after their contract ends: the report names it first.
    await act(page, contract, "TRANSFER");
    await sheet(page).getByRole("combobox", { name: "어디로" }).fill("생산2팀");
    await page.getByRole("option", { name: /생산2팀/ }).click();
    await sheet(page).getByRole("textbox", { name: /^언제부터/ }).fill(kstDate(50));
    const reason = sheet(page).getByRole("radiogroup", { name: /사유 분류/ });
    if (await reason.isVisible()) await reason.getByRole("radio").first().locator("xpath=ancestor::label[1]").click();
    await sheet(page).getByRole("textbox", { name: /사유 메모|^사유/ }).fill("라인 재배치");
    await sheet(page).getByRole("button", { name: `전보 예약 · ${koDate(kstDate(50))} 시행`, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
    await act(page, contract, "exit.report");
    await sheet(page).getByRole("button", { name: /^계약 종료일/ }).click();
    await sheet(page).getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("계약기간 만료", { exact: true }).click();
    await sheet(page).getByRole("textbox", { name: /^퇴직 경위/ }).fill("계약기간 만료");
    await shot(page, "E5-exit");
  });
  await frame(page, "E3-rehire", async () => {
    // 김민준 leaves today (report, then HR's confirmation), and comes back: 재입사로 등록 from the record.
    await act(page, hero, "exit.report");
    await sheet(page).getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(0));
    await sheet(page).getByRole("textbox", { name: /^퇴직 경위/ }).fill("개인 사정");
    await sheet(page).getByRole("button", { name: /퇴직 보고$/ }).click();
    await page.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
    await signOff(page.getByRole("dialog").getByRole("group", { name: "확인 사항" }));
    await page.getByRole("dialog").getByRole("button", { name: /퇴직 1명 (반영|예약)/ }).click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
    await act(page, hero, "rehire");
    await shot(page, "E3-rehire");
  });
}
