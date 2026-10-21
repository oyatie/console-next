import { expect, type Locator, type Page } from "@playwright/test";

export const filingRow = (page: Page, insurer: string, kind: string) => page.getByRole("row").filter({has:page.getByRole("cell",{name:`${insurer} · ${kind}`,exact:true})});

export async function selectFilingFact(page: Page, dialog: Locator, label: string, option: string) {
  const control = dialog.getByRole("button", { name: new RegExp(`(?:^|\\s)${label}(?:\\s|$)`) });
  await control.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

export async function prepareFilingCompletion(page: Page, dialog: Locator) {
  await selectFilingFact(page, dialog, "처리 방법", "신고 완료");
  for (const [label,value] of [["생년월일","1990-01-01"],["월 소정근로시간","160"],["주 소정근로시간","40"],["계속 근로 개월 수","3"]] as const) {
    const input = dialog.getByLabel(new RegExp(`^${label}`));
    if (await input.count()) await input.fill(value);
  }
  for (const label of ["일용근로자", "근로자성이 없는 임원", "외국인"]) {
    if (await dialog.getByRole("button", { name: new RegExp(`(?:^|\\s)${label}(?:\\s|$)`) }).count()) await selectFilingFact(page, dialog, label, "미해당");
  }
}

export async function resolveFilingNotApplicable(page: Page, row: Locator) {
  await row.getByRole("button", { name: "처리 기록", exact: true }).click();
  const dialog=page.getByRole("dialog");
  await selectFilingFact(page,dialog,"처리 방법","미해당");
  await selectFilingFact(page,dialog,"미해당 사유","그 밖의 법정 미해당 사유");
  await dialog.getByRole("textbox",{name:/^사유의 근거/}).fill("공단 확인 · 별도 법정 적용 제외 근거 보관");
  await dialog.getByRole("button",{name:"미리보기",exact:true}).click();
  await expect(dialog).toContainText("신고일은 기록하지 않으며");
  await dialog.getByRole("button",{name:"미해당",exact:true}).click();
  await expect(dialog).toBeHidden();
}
