import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go } from "./flows";
import { tenantInSetup } from "./setup-flows";

// S7 사업장 일괄 수정 from an empty tenant, through the UI only: a second 사업장 made by a pasted list with its
// 4대보험 "not yet", then both edited together — the one already established stays and says so, the other changes,
// and the primary names the real count.

const ENTITY = "새온물류";
const radio = (scope: Page | Locator, group: string, name: string) => scope.getByRole("radiogroup", { name: new RegExp(group) }).getByText(name, { exact: true });

test("edit two 사업장 together: the row already established stays, the other gets its 4대보험 state @org", async ({ browser }) => {
  const { admin: page } = await tenantInSetup(browser, "bulkedit", ENTITY, false, "인천 본사");

  // A second 사업장 whose 4대보험 is not established yet, through the paste path.
  await go(page, "/org/paste");
  await radio(page, "어디 아래에", `주식회사 ${ENTITY}`).click();
  await page.getByLabel("붙여넣은 내용").fill("광주지점\n\t영업팀");
  const card = page.getByRole("region", { name: "새 사업장 · 광주지점" });
  await radio(card, "원천징수 신고", "본점에서 함께 신고").click();
  await radio(card, "4대보험", "아직 없음").click();
  await card.getByRole("button", { name: "주소를 직접 입력" }).click();
  const addr = card.getByRole("group", { name: "주소", exact: true });
  await addr.getByLabel("도로명주소").fill("광주광역시 북구 첨단과기로 123");
  await addr.getByLabel("우편번호 (5자리)").fill("61005");
  await addr.getByRole("button", { name: "이 주소로 저장" }).click();
  await card.getByLabel("개설일").fill("2026-10-01");
  await page.getByRole("button", { name: /개 추가$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "기록됨" })).toContainText("사업장 1곳 · 부서 1개를 추가했습니다");

  await go(page, "/org/workplaces/edit");
  await page.getByRole("checkbox", { name: `주식회사 ${ENTITY} › 인천 본사` }).check();
  await page.getByRole("checkbox", { name: `주식회사 ${ENTITY} › 광주지점` }).check();
  await page.getByRole("button", { name: "2곳 일괄 수정" }).click();
  const sheet = page.getByRole("dialog", { name: "사업장 2곳 일괄 수정" });
  await expect(sheet).toContainText("선택한 사업장 2곳 · 법인 1곳");
  // Nothing preselected: the type needs the server's type list and says so.
  await expect(sheet.getByText("사업장 종류는 종류 목록이 열린 서버에서 변경합니다")).toBeVisible();
  await radio(sheet, "무엇을 변경합니까", "4대보험 상태 지정").click();
  await radio(sheet, "^4대보험", "모두 성립 · 번호는 나중에").click();
  await sheet.getByLabel("언제부터").fill("2026-10-01");
  const rows = sheet.getByRole("table", { name: "사업장마다 바뀌는 것" });
  await expect(rows.getByRole("row").filter({ hasText: "인천 본사" })).toContainText("그대로 · 이미 그 상태");
  await expect(rows.getByRole("row").filter({ hasText: "광주지점" })).toContainText("성립 · 번호 입력 전 · 2026. 10. 01.");
  await expect(sheet).toContainText("바뀜 1곳 · 바뀌지 않음 1곳");
  await expectAccessible(page, "workplace bulk edit");
  await sheet.getByRole("button", { name: "1곳 변경" }).click();
  await expect(sheet).toBeHidden();
  // Reopened, the changed row is now settled too.
  await page.getByRole("button", { name: "2곳 일괄 수정" }).click();
  await radio(sheet, "무엇을 변경합니까", "4대보험 상태 지정").click();
  await radio(sheet, "^4대보험", "모두 성립 · 번호는 나중에").click();
  await expect(sheet).toContainText("바뀜 0곳 · 바뀌지 않음 2곳");
  await expect(sheet.getByRole("button", { name: "0곳 변경" })).toHaveAttribute("aria-disabled", "true");
});
