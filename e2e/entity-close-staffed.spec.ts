import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, option } from "./flows";
import { hire } from "./helpers/close";
import { addDepts } from "./helpers/structure";
import { sheet } from "./sheet";
import { startOperations, tenantInSetup } from "./setup-flows";
import { leaveScreen } from "./structure-flows";

// UX-R2 ENDS (company-18, company-52): closing a 법인 that still employs people. The copy names no 전적 (it does not
// exist); the remedy opens this 법인's own people's exits right in the sheet (one last working day, 폐업 · 도산) instead
// of the unfiltered roster; and every exit still open is listed with its 금품청산 deadline, linked.
// regression: on the parent the remedy was a bare link to /people and the copy sent people to 전적.

test("regression: a staffed 법인's close opens its people's exits in place and lists the open ones (company-18, company-52)", { tag: ["@regression", "@org"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "entclose", "종료회사", false, "본사");
  await addDepts(admin, "본사", ["인사팀"]);
  await hire(admin, "최직원", "인사팀", "본사");
  await startOperations(admin);
  await leaveScreen(admin);

  await go(admin, "/org/entities");
  await admin.getByRole("row", { name: /종료회사/ }).click();
  await admin.getByRole("button", { name: "법인 종료 계획 보기" }).click();
  const s = sheet(admin, "법인 종료");
  await expect(s).toContainText("재직자 1명");
  await expect(s).not.toContainText("전적");
  await s.getByRole("button", { name: "재직자 퇴직 처리" }).click();
  const open = s.getByRole("button", { name: "재직자 1명 퇴직 처리 열기" });
  await expect(open).toHaveAccessibleDescription("마지막 근무일과 퇴직 사유를 선택하면 열 수 있습니다.");
  await s.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate());
  await option(admin, "퇴직 사유", "폐업").click();
  await expectAccessible(admin, "entity close: people's exits in place");
  await open.click();
  await expect(s.getByRole("status").filter({ hasText: "1명의 퇴직 처리를 열었습니다" })).toBeVisible();
  // company-52: the exit now in flight is listed with its 금품청산 deadline, linked to the case.
  await expect(s.getByRole("link", { name: /^최직원 · 퇴직일 .+ · 금품청산 .+까지$/ })).toBeVisible();
  const shots = process.env.ENDS_SHOTS;
  if (shots) await admin.screenshot({ path: `${shots}/after-08-entity-close.png`, fullPage: true });
});
