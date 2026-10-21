import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { inviteAccount } from "./access-flows";
import { firstSignIn, go } from "./flows";
import { homeRail, setupRail, startOperations, tenantInSetup } from "./setup-flows";

// UX-R1 HOME: the work queue tells the truth. A part the viewer may not read, or that failed, is named, never read as
// "nothing to do"; a refused read is asked once; an account with no work grant gets an honest page; the setup rail
// never counts or promises a security contact no screen can record.

/** Requests the page sends whose path (and query) matches `url`, counted from now. */
function counter(page: Page, url: RegExp) {
  let n = 0;
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (url.test(u.pathname + u.search)) n += 1;
  });
  return () => n;
}
/** Invites someone who is not an employee with no grant (an invite carries no access, governance-01); returns their first sign-in code. */
const inviteMember = (admin: Page, name: string) => inviteAccount(admin, name, "none");
const refused = { status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "forbidden" } }) };

// regression (governance-07, worst-case-38): no 보안 연락처 step is counted 완료 or promised while none can be recorded.
test("the setup rail and go-live promise no security contact that cannot be recorded", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "truthrail", "약속상사");
  await go(admin, "/");
  await expect(await homeRail(admin)).toBeVisible();
  await expect(setupRail(admin)).not.toContainText("보안 연락처");
  await go(admin, "/setup/go-live");
  await expect(admin.getByRole("heading", { name: "운영 시작", level: 1 })).toBeVisible();
  // company-49 (UX-R2 SETUP): a capability that is not offered gets no line on the preview at all.
  await expect(admin.getByRole("button", { name: "운영 시작", exact: true })).toBeVisible();
  await expect(admin.getByRole("main")).not.toContainText("보안 연락처");
});

test("home names a refused and a failed part and asks a refusal once; the calendar locks a month", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "truthq", "정직상사");
  await startOperations(admin);

  // regression (governance-16, governance-32): one part refused, one failed. Both are named above the queue, the
  // failed one retries, the refused one is asked once, and the empty queue says only what it could read is empty.
  await admin.route(/\/api\/v1\/hr\/exit-cases(\?|$)/, (r) => r.fulfill(refused));
  await admin.route(/\/api\/v1\/employees\?.*identity_review_required=true/, (r) => r.fulfill({ status: 500, body: "" }));
  // A fresh load, so Home reads every part through the faults (in-app navigation would keep the cached reads).
  const exitReads = counter(admin, /^\/api\/v1\/hr\/exit-cases(\?|$)/);
  const identityReads = counter(admin, /^\/api\/v1\/employees\?.*identity_review_required=true/);
  await admin.reload();
  const denied = admin.getByRole("region", { name: "일부 항목은 볼 권한이 없습니다" });
  await expect(denied).toContainText("퇴직");
  const failed = admin.getByRole("alert").filter({ hasText: "일부 항목을 불러오지 못했습니다" });
  await expect(failed).toContainText("확인할 직원 기록");
  await expect(admin.getByRole("heading", { name: "볼 수 있는 항목 중에는 처리할 일이 없습니다" })).toBeVisible();
  await expect(admin.getByRole("heading", { name: "처리하거나 확인할 일이 없습니다" })).toHaveCount(0);
  await expect(admin.getByRole("group", { name: "업무 구분" })).toBeVisible();
  await expectAccessible(admin, "home with a refused and a failed part");
  // 다시 불러오기 asks the failed part again (and only it); once the fault clears, the notice goes.
  const asked = identityReads();
  await failed.getByRole("button", { name: "다시 불러오기" }).click();
  await expect.poll(identityReads).toBeGreaterThan(asked);
  await expect(failed).toBeVisible();
  await admin.unroute(/\/api\/v1\/employees\?.*identity_review_required=true/);
  await failed.getByRole("button", { name: "다시 불러오기" }).click({ timeout: 5_000 }).catch(() => undefined);
  await expect(failed).toBeHidden();
  await expect(denied).toBeVisible();
  await admin.waitForTimeout(3_000);
  expect(exitReads(), "a refused part is asked once, not retried").toBe(1);
  await admin.unroute(/\/api\/v1\/hr\/exit-cases(\?|$)/);

  // governance-39: the 12-month calendar. L on an open month starts its lock there; the locked month then says so and
  // Enter shows its lock in the list; arrows move across months.
  await go(admin, "/people/period-locks");
  const strip = admin.getByRole("grid", { name: "최근 12개월" });
  const last = strip.getByRole("row").first().getByRole("button").last();
  await expect(last).toHaveAccessibleName(/^급여 \d{4}년 \d{1,2}월 열림 · 이 달 잠금$/);
  await last.focus();
  await admin.keyboard.press("ArrowLeft");
  await expect(strip.getByRole("row").first().getByRole("button").nth(10)).toBeFocused();
  await admin.keyboard.press("ArrowRight");
  await admin.keyboard.press("l");
  await expect(admin.getByRole("radio", { name: "급여", exact: true })).toBeChecked();
  await admin.getByRole("radiogroup", { name: /잠금 사유/ }).getByText("월 급여 마감", { exact: true }).click();
  await admin.getByRole("button", { name: /^급여 \d{4}년 \d{1,2}월 잠금$/ }).click();
  await expect(last).toHaveAccessibleName(/^급여 \d{4}년 \d{1,2}월 잠김 · 급여 · \d{4}년 \d{1,2}월 마감 \(/);
  await expectAccessible(admin, "period-lock calendar");
  await last.focus();
  await admin.keyboard.press("Enter");
  await expect(admin.getByRole("row", { name: /월 급여 마감/ }).getByRole("button", { name: /잠금 해제/ })).toBeFocused();

});

test("an account with no work grant gets an honest home, and 기간 잠금 refuses it once", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "truthn", "권한없음상사");
  await startOperations(admin);
  const exec = await firstSignIn(browser, await inviteMember(admin, "박사원"));

  // regression (governance-21, people-self-04): 기간 잠금 by URL without the grant is asked once (the parent re-asked on
  // every mount, ~316 GET in 3 min), then one typed refusal and no 「새 기간 잠금」.
  const lockReads = counter(exec, /^\/api\/v1\/period-locks(\?|$)/);
  await go(exec, "/people/period-locks");
  await exec.waitForTimeout(5_000);
  expect(lockReads(), "a refused list is asked once").toBe(1);
  await expect(exec.getByRole("heading", { name: "기간 잠금을 볼 권한이 없습니다" })).toBeVisible();
  await expect(exec.getByText("기간 잠금 관리 권한이 필요합니다", { exact: false })).toBeVisible();
  await expect(exec.getByRole("button", { name: "새 기간 잠금" })).toHaveCount(0);
  await expectAccessible(exec, "period locks refused");

  // regression (people-self-26): an account with no work grant gets its account, not an HR console with lanes and quick
  // links it cannot use (sign-out stays in the top bar, once).
  await go(exec, "/");
  await expect(exec.getByRole("heading", { name: "이 계정으로 처리할 업무가 없습니다" })).toBeVisible();
  await expect(exec.getByTestId("home-no-work").getByRole("link", { name: "내 계정" })).toBeVisible();
  await expect(exec.getByRole("button", { name: "로그아웃" })).toHaveCount(1);
  await expect(exec.getByRole("group", { name: "업무 구분" })).toHaveCount(0);
  await expect(exec.getByRole("heading", { name: "처리하거나 확인할 일이 없습니다" })).toHaveCount(0);
  await expectAccessible(exec, "home with no work grant");
});
