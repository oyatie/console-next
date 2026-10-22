import { expect, test, type Page } from "@playwright/test";
import { ko } from "../packages/i18n/src/catalogs/ko";
import { expectAccessible } from "./a11y";
import { chooseRadio, firstSignIn, go, kstDate, registerEmployee, stepUp, takeCode } from "./flows";
import { staffedTenant } from "./setup-flows";
import { signOff } from "./sheet";
import { bearerOf } from "./helpers/api";
import { activatePendingGrants } from "./second-person-fixture";

// The pilot's HR worker, end to end (regressions governance-02/03/people-self-01 and governance-04/move-03): an
// employee's account, signed in once with nothing, is granted 인사 실무 over the 법인 AND 권한 관리 over 회사 전체.
// Both grants 적용 중 must mean the HR worker reads the roster (it was 「접근 권한이 없습니다」 on the parent). Then the
// worker leaves: confirming the exit ends both grants and the account, and the open session reaches nothing.

/** A role from the grid: its name, then each cell by its accessible name 「<domain> <level>」. */
async function role(admin: Page, name: string, cells: string[]) {
  await go(admin, "/access/roles");
  await admin.getByRole("link", { name: "역할 추가" }).first().click();
  await admin.getByRole("textbox", { name: /^역할 이름/ }).fill(name);
  for (const cell of cells) await admin.getByRole("button", { name: cell, exact: true }).click();
  await admin.getByRole("button", { name: "역할 추가" }).click();
  await expect(admin.getByRole("row", { name: new RegExp(name) })).toBeVisible();
}

/** One grant to `who` of `roleName` over the scope row `scope`, for a year, with the admin's passkey. */
async function grant(admin: Page, who: string, roleName: string, scope: RegExp) {
  const token = bearerOf(admin);
  await go(admin, "/access/grants");
  await admin.getByRole("combobox", { name: "권한을 부여할 사람 (이름 또는 사번)" }).fill(who);
  await admin.getByRole("option", { name: new RegExp(who) }).first().click();
  const sheet = admin.getByRole("dialog", { name: "권한 부여" });
  await sheet.getByRole("button", { name: / 역할$/ }).click();
  await admin.getByRole("option", { name: new RegExp(`^${roleName}`) }).click();
  await sheet.getByRole("button", { name: /범위 선택/ }).click();
  const pick = admin.getByRole("dialog", { name: "범위 선택" });
  await pick.getByRole("row", { name: scope }).first().click();
  await pick.getByRole("button", { name: "이 범위로 설정" }).click();
  await sheet.getByRole("button", { name: /^1년/ }).click();
  await chooseRadio(sheet, new RegExp(`^${ko["accessGrants.start.NOW"]}`));
  await chooseRadio(sheet, /^업무 배정·변경/);
  await sheet.getByRole("button", { name: "패스키로 확인하고 부여 1건 저장" }).click();
  await stepUp(sheet, "패스키로 확인하고 부여 1건 저장", admin.getByRole("status").filter({ hasText: `${who}님에게 부여 1건을 저장했습니다` }));
  await activatePendingGrants(admin, token);
}

test("an HR worker granted 인사 실무 over the 법인 and 권한 관리 over 회사 전체 works, and loses it all on exit", { tag: ["@access", "@hr"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "hrwalk", "늘봄정밀");

  // The HR worker is an employee; the account is invited from the record (linked) and signs in with nothing.
  await registerEmployee(admin, { name: "김인사", number: "NB-0001", unit: "인사부", hired: kstDate(-30) });
  const record = admin.url();
  await admin.getByRole("button", { name: "계정 초대" }).click();
  const invite = admin.getByRole("dialog", { name: "계정 초대" });
  await stepUp(invite, "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  const hr = await firstSignIn(browser, await takeCode(admin));
  // With nothing granted, no roster is readable, and a refused screen names the way forward.
  await go(hr, "/people");
  await expect(hr.getByRole("rowheader", { name: "김인사", exact: true })).toHaveCount(0);
  await go(hr, "/access/roles");
  await expect(hr.getByRole("heading", { name: "접근 권한이 없습니다" })).toBeVisible();
  // The refusal names the way forward, without a title noun (people-self-05, governance-30): 권한 요청 (people-self-38).
  await expect(hr.getByRole("button", { name: "권한 요청" })).toBeVisible();
  await expectAccessible(hr, "denied with a way forward");

  await role(admin, "인사 실무", ["인사기본 등록·수정", "발령 등록·수정", "퇴직 등록·수정", "조직 조회"]);
  await role(admin, "권한 관리 담당", ["권한 관리 등록·수정"]);
  await grant(admin, "김인사", "인사 실무", /주식회사 늘봄정밀/);
  await grant(admin, "김인사", "권한 관리 담당", /^전체/);
  await go(admin, "/access/grants");
  await admin.reload();
  await expect(admin.getByRole("row", { name: /김인사/ })).toHaveCount(2);
  for (const row of await admin.getByRole("row", { name: /김인사/ }).all()) await expect(row).toContainText("적용 중");

  // Both grants count, so the HR worker reads the roster and the 법인 (governance-02, regression). The worker's open
  // page learns of new access on its next load (a live push of /me/authz is the realtime lane's, #27).
  await go(hr, "/people");
  await hr.reload();
  await expect(hr.getByRole("heading", { name: "접근 권한이 없습니다" })).toHaveCount(0);
  await expect(hr.getByRole("rowheader", { name: "김인사", exact: true })).toBeVisible();
  await go(hr, "/org/entities");
  await expect(hr.getByRole("heading", { name: "접근 권한이 없습니다" })).toHaveCount(0);
  // 내 권한: what I hold, by role and scope, never a title (operations catalog governance-22).
  await go(hr, "/account");
  // (Scoped to the card: with one passkey, My account also leads with 「다른 기기에 패스키 하나 더」, which names 권한 관리 담당자.)
  const mine = hr.getByRole("region", { name: "내 권한" });
  await expect(mine.getByText("인사 실무")).toBeVisible();
  await expect(mine.getByText("권한 관리 담당")).toBeVisible();
  await expectAccessible(hr, "my access");

  // The worker leaves (last day yesterday): confirming the exit ends every grant and the account (governance-04).
  await go(admin, new URL(record).pathname);
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const report = admin.getByRole("dialog");
  await report.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(-1));
  await report.getByLabel("퇴직 경위").fill("개인 사정으로 사직");
  await report.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await report.getByRole("button", { name: "퇴직 보고" }).click();
  const exit = admin.getByRole("region", { name: "퇴직", exact: true });
  await exit.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
  const confirm = admin.getByRole("dialog");
  await signOff(confirm.getByRole("group", { name: "확인 사항" }), (l) => l.click());
  await confirm.getByRole("button", { name: /인사 확인하고/ }).click();
  await expect(confirm).toBeHidden();
  await expect(exit).toContainText("인사 확인됨");

  await go(admin, "/access/grants");
  await expect(admin.getByRole("row", { name: /김인사/ })).toHaveCount(0);
  // A fresh read (the list a tab already holds learns of it through the realtime lane, #27).
  await go(admin, "/people?view=accounts");
  await admin.reload();
  await expect(admin.getByRole("row", { name: /김인사/ })).toHaveCount(0);
  await admin.getByRole("button", { name: "비활성 계정 포함" }).click();
  await expect(admin.getByRole("row", { name: /김인사/ })).toContainText("비활성화됨");

  // The leaver's session is gone: the next load cannot refresh it and lands on sign-in, reaching no data.
  await go(hr, "/people");
  await hr.reload();
  await expect(hr.getByRole("heading", { name: "접근 권한이 없습니다" }).or(hr.getByRole("button", { name: "패스키로 로그인" }))).toBeVisible();
  await expect(hr.getByRole("rowheader", { name: "김인사", exact: true })).toHaveCount(0);
});
