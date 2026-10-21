import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, registerEmployee, stepUp, takeCode } from "./flows";
import { staffedTenant } from "./setup-flows";

// Accounts from people (governance-01, regression): there are no preset roles. An invite starts from an employee
// record (linked on create), asks only who, creates an account with no access, and continues into 권한 부여; it stops
// when the person already has an account. The ops account is named 운영 계정 and cannot be deactivated (governance-22).
test("accounts: invite with no role, continue into 권한 부여, find the existing account, ops is protected", { tag: "@access" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "acctsco", "계정상사");
  await registerEmployee(admin, { name: "정하늘", number: "HK-4112", unit: "채용팀" });

  // The invite starts from the person: their page finds no account to link and invites them, already chosen.
  await admin.getByRole("button", { name: "계정 초대" }).click();
  const sheet = admin.getByRole("dialog", { name: "계정 초대" });
  await expect(sheet.getByRole("combobox", { name: "초대할 직원" })).toHaveValue("정하늘");
  // No title to pick: no role, no 지점 (the old 구성원/관리자/임원/최고 관리자 cards are gone).
  await expect(sheet.getByRole("radio")).toHaveCount(0);
  await expect(sheet).not.toContainText(/최고 관리자|구성원|소속 지점/);
  await expect(sheet).not.toContainText("초대한 계정에는 권한이 없습니다");
  await expect(sheet).toContainText("정하늘(HK-4112) 계정을 생성하고 첫 로그인 코드를 발급합니다. 계정에는 아직 아무 권한이 없으며");
  await expectAccessible(admin, "invite sheet");
  await stepUp(sheet, "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  // The one-time code offers to continue into 권한 부여 for this account.
  await expect(admin.getByRole("dialog").getByRole("link", { name: "전달하고 권한 부여로" })).toBeVisible();
  await takeCode(admin);

  const panel = admin.getByRole("complementary", { name: "정하늘" });
  await expect(panel.getByRole("status")).toContainText("정하늘님의 계정을 생성하고 첫 로그인 코드를 발급했습니다");
  // Created already linked to the employee record (one request); access is a link, never a title.
  await expect(panel.getByRole("link", { name: "정하늘 · HK-4112" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "역할 변경" })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "이 사람이 할 수 있는 일" })).toBeVisible();
  await expect(admin.getByRole("row", { name: /정하늘/ })).toContainText("HK-4112");
  await expect(admin.getByRole("group", { name: "역할" })).toHaveCount(0);
  await expectAccessible(admin, "account panel");

  // A second invite for the same person, picked by number, stops at the account that exists.
  await admin.getByRole("button", { name: "계정 초대" }).click();
  await sheet.getByRole("combobox", { name: "초대할 직원" }).fill("HK-4112");
  await admin.getByRole("option", { name: /정하늘/ }).click();
  await expect(sheet).toContainText("이 직원에게는 이미 계정이 있습니다");
  await sheet.getByRole("button", { name: "그 계정 열기" }).click();
  await expect(sheet).toBeHidden();
  await expect(panel).toBeVisible();

  // 권한 부여 from the panel opens the grant sheet for this account.
  await panel.getByRole("link", { name: "권한 부여" }).click();
  await expect(admin).toHaveURL(/\/access\/people\/[0-9a-f-]+/);
  await expect(admin.getByRole("dialog", { name: "권한 부여" })).toContainText("정하늘");
  await admin.getByRole("dialog", { name: "권한 부여" }).getByRole("button", { name: "취소" }).click();

  // The ops account is the one preset: named 운영 계정, and 비활성화 is replaced by its reason (governance-22).
  await go(admin, "/people?view=accounts");
  const ops = admin.getByRole("row", { name: /운영 계정/ });
  await expect(ops).toBeVisible();
  await expect(admin.getByRole("row", { name: /Tenant Admin/ })).toHaveCount(0);
  await ops.click();
  const opsPanel = admin.getByRole("complementary", { name: "운영 계정" });
  await expect(opsPanel).toContainText("운영 계정은 비활성화할 수 없습니다");
  await expect(opsPanel).toContainText("역할 없이 모든 권한");
  await expect(opsPanel.getByRole("button", { name: "계정 비활성화" })).toHaveCount(0);
  await expectAccessible(admin, "ops account panel");
});
