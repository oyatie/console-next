import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { grantAccess } from "./access-flows";
import { firstSignIn, go, kstDate, registerEmployee, stepUp, submitRegistration, takeCode } from "./flows";
import { staffedTenant } from "./setup-flows";
import { cardVerbs, hrItem, hrMenu, reloadRecord } from "./record";
import { reasonChip } from "./helpers/lifecycle";

// UX-loop r2 group GUARDS, regressions on one operating tenant whose admin is the only ops account:
// people-self-33 — an HR worker holding every HR edit over the company reported and HR-confirmed their OWN exit; no
//   verb is offered on one's own record now (the server refuses own_record_forbidden, backend tests).
// governance-02 — the only ops holder could reset its own only passkey (the code hid under 「다시 로그인」); the verb
//   now says why not and where a second passkey is added.
// governance-03 — the ops panel promised a 「운영 계정 인계」 that does not exist.
// records-02 — after a 사번 변경 retired E-000001, every registration with 사번 empty was refused 409 and shown as
//   「요청을 처리하지 못했습니다」; the next number skips it, and a taken number is named with its remedy.

/** Re-walk evidence (UX loop): `GUARDS_SHOTS=<dir>` saves the after screens; unset, nothing is written. */
const shot = (p: Page, name: string) => (process.env.GUARDS_SHOTS ? p.screenshot({ path: `${process.env.GUARDS_SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());
const path = (p: Page) => new URL(p.url()).pathname;

test("nobody acts on their own record, the bootstrap admin keeps its sign-in path, and the auto 사번 never collides", { tag: ["@hr", "@access", "@regression"] }, async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const { admin } = await staffedTenant(browser, "guards", "늘봄정밀");
  let hr!: Page;
  let other = "";

  await test.step("people-self-33: no exit verb on one's own record", async () => {
    await registerEmployee(admin, { name: "김인사", number: "NB-0001", unit: "인사부" });
    const own = path(admin);
    await admin.getByRole("button", { name: "계정 초대" }).click();
    await stepUp(admin.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
    hr = await firstSignIn(browser, await takeCode(admin));
    await grantAccess(admin, "김인사", "full");
    await registerEmployee(admin, { name: "이직원", number: "NB-0002", unit: "인사부" });
    other = path(admin);

    // Someone else's record: the HR worker's ordinary work. The open page learns of the new grant on its next load.
    await reloadRecord(hr, other);
    await expect(hr.getByRole("button", { name: "퇴직 보고" })).toBeVisible();
    // One's own record: nothing to report, and a deep link to the sheet says it is not available.
    // The worker's first load of a person page shifts while /me/authz lands (the head waits for it; ask to FE-EMP-B2);
    // that load is this spec's set-up. The own-record screen is judged from the navigation to it.
    await hr.evaluate(() => void window.__shifts?.splice(0));
    await go(hr, own);
    await expect(hr.getByRole("heading", { name: /김인사/, level: 1 })).toBeVisible();
    // No 발령 is offered on it (the read's allowed events are empty): each stays listed in the card's 발령 menu, refused
    // with the rule; the head's end verbs (from the record's end offers) are refused with the rule too.
    const acts = await hrMenu(hr);
    await expect(hrItem(acts, "전보")).toHaveAttribute("aria-disabled", "true");
    await expect(hrItem(acts, "전보")).toContainText("본인의 인사 기록은 직접 처리할 수 없습니다");
    await hr.keyboard.press("Escape");
    await expect(hr.getByRole("button", { name: "퇴직", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(hr.getByText("본인의 인사 기록입니다 · 범위 안의 다른 담당자나 운영 계정이 처리합니다").first()).toBeVisible();
    // The verb stays in place, refused with the rule and who records it (DisabledReason: aria-disabled, focusable).
    const refusedVerb = hr.getByRole("region", { name: "퇴직", exact: true }).getByRole("button", { name: "퇴직 보고" });
    await expect(refusedVerb).toHaveAttribute("aria-disabled", "true");
    await expect(hr.getByText(/본인의 인사 기록은 직접 처리할 수 없습니다/).first()).toBeVisible();
    await shot(hr, "ps33-own-record-after");
    await expectAccessible(hr, "own record: the exit verb refused with its rule");
    await refusedVerb.click({ force: true });
    await expect(hr.getByRole("dialog")).toHaveCount(0);
    await go(hr, `${own}?act=exit.report`);
    await expect(hr.getByRole("dialog").getByText("이 조치는 지금 할 수 없습니다")).toBeVisible();

    // The ops account reports it; the case on the worker's own record offers the worker no step.
    await go(admin, own);
    await admin.getByRole("button", { name: "퇴직 보고" }).click();
    const report = admin.getByRole("dialog");
    await report.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(30));
    await report.getByLabel("퇴직 경위").fill("본인 사정");
    await report.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
    const exit = admin.getByRole("region", { name: "퇴직", exact: true });
    await expect(exit).toContainText("보고됨");
    await expect(exit.getByRole("button", { name: "인사 확인하고 퇴직 처리" })).toBeVisible();
    await reloadRecord(hr, own);
    const mine = hr.getByRole("region", { name: "퇴직", exact: true });
    await expect(mine).toContainText("보고됨");
    await expect(mine.getByRole("button")).toHaveCount(0);
    await shot(hr, "ps33-own-case-after");
  });

  await test.step("governance-02/03: the bootstrap admin's own reset says why not; no handover promised", async () => {
    await go(admin, "/people?view=accounts");
    await admin.getByRole("row").filter({ hasText: "운영 계정" }).first().click();
    const panel = admin.getByRole("complementary").filter({ has: admin.getByRole("heading", { name: /운영|ops/ }) }).last();
    const reset = admin.getByRole("button", { name: "패스키 초기화" });
    await expect(reset).toHaveAttribute("aria-disabled", "true");
    await expect(admin.getByText("내 계정의 패스키는 초기화할 수 없습니다 · 다른 기기에 새 패스키를 먼저 등록하십시오")).toBeVisible();
    await expect(admin.getByRole("link", { name: "내 계정에서 패스키 등록" })).toHaveAttribute("href", "/account");
    await reset.click({ force: true });
    await expect(admin.getByRole("dialog", { name: "패스키 초기화" })).toHaveCount(0);
    await expect(admin.getByText("내 계정은 비활성화할 수 없습니다 · 다른 권한 관리 담당자가 합니다")).toBeVisible();
    await expect(panel).not.toContainText("인계");
    await shot(admin, "gov02-ops-panel-after");
    await expectAccessible(admin, "ops account panel: own reset refused with its fix");

    // K1 (account-link guard): one's own account is never linked by oneself; another holder requests it with a passkey
    // and a second person approves (e2e/account-link-guard.spec.ts). The sole ops account's panel offers no link.
    // ponytail: the ops-exit note (accounts.ops.exitNote) needs that two-admin world here; it is not walked meanwhile.
    await expect(panel.getByRole("combobox", { name: "연결할 직원" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /직원 연결/ })).toHaveCount(0);
  });

  await test.step("records-02: the auto 사번 skips a retired one; a taken one is named with its remedy", async () => {
    await registerEmployee(admin, { name: "박자동", unit: "인사부" });
    await expect(admin.getByRole("main")).toContainText("E-000001");
    // The card's 사번 변경 sheet (⋯ menu): the new number, from today, why.
    await cardVerbs(admin).getByRole("button", { name: "더 보기" }).click();
    await admin.getByRole("menuitem", { name: "사번 변경" }).click();
    const empno = admin.getByRole("dialog");
    await empno.getByRole("textbox", { name: "새 사번" }).fill("HB-1001");
    await empno.getByRole("radiogroup", { name: /언제부터/ }).getByText("오늘부터", { exact: true }).click();
    await reasonChip(empno, "사번 체계 변경", "사유").click();
    await empno.getByRole("button", { name: "사번 1명 변경", exact: true }).click();
    await expect(admin.getByText("사번을 HB-1001로 변경했습니다")).toBeVisible();

    await registerEmployee(admin, { name: "최자동", unit: "인사부" });
    await expect(admin.getByRole("main")).toContainText("E-000002");
    await submitRegistration(admin, { name: "정수동", number: "E-000001", unit: "인사부" });
    await expect(admin.getByRole("alert")).toContainText("사번 E-000001은 예전 사번으로 묶여 있습니다 · 다른 사번을 쓰거나, 비워 두면 다음 사번을 자동으로 부여합니다");
    await expect(admin.getByRole("alert")).not.toContainText("요청을 처리하지 못했습니다");
    await shot(admin, "rec02-register-after");
  });
});
