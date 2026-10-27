// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { components } from "@console/api/schema";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { inviteAccount } from "./access-flows";
import { firstSignIn, go } from "./flows";
import { forgetResize } from "./stability";
import { homeRail, setupRail, startOperations, tenantInSetup } from "./setup-flows";

// Home keeps healthy sources visible when another source fails;
// refused sources are absent server-side, and a refused aggregate is asked once.

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

async function walkHome(page: Page, state: string, info: TestInfo) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await forgetResize(page);
  const capture = async (width: number) => {
    await expectAccessible(page, `Home ${state} at ${width}px`);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
      await page.screenshot({ path: info.outputPath(`home-${state}-${width}-${theme}.png`), fullPage: true });
    }
  };
  await capture(1440);
  await atPhoneWidth(page, async () => { await fits(page, `Home ${state}`); await capture(390); });
}

// regression (governance-07, worst-case-38): no 보안 연락처 step is counted 완료 or promised while none can be recorded.
test("the setup rail and go-live promise no security contact that cannot be recorded", { tag: "@hr" }, async ({ browser }, info) => {
  const { admin } = await tenantInSetup(browser, "truthrail", "약속상사");
  await go(admin, "/");
  await expect(await homeRail(admin)).toBeVisible();
  const inbox = admin.getByRole("region", { name: "업무함", exact: true });
  await expect(inbox.getByRole("region", { name: /운영 준비/ })).toHaveCount(1);
  await expect(setupRail(admin)).toHaveCount(1);
  await expect(setupRail(admin)).not.toContainText("보안 연락처");
  await walkHome(admin, "setup", info);
  await go(admin, "/setup/go-live");
  await expect(admin.getByRole("heading", { name: "운영 시작", level: 1 })).toBeVisible();
  // company-49 (UX-R2 SETUP): a capability that is not offered gets no line on the preview at all.
  await expect(admin.getByRole("button", { name: "운영 시작", exact: true })).toBeVisible();
  await expect(admin.getByRole("main")).not.toContainText("보안 연락처");
});

test("Home keeps healthy work through a source failure, retries it, and asks a refusal once; the calendar locks a month", { tag: "@hr" }, async ({ browser }, info) => {
  const { admin } = await tenantInSetup(browser, "truthq", "정직상사");
  await startOperations(admin);
  const inboxPath = /\/api\/v1\/me\/action-inbox(\?|$)/;
  const supportReference = "0123456789abcdef0123456789abcdef";
  let fail = true;
  let healthyTitle = "";
  // regression (governance-32): a failed source leaves every healthy source visible and names its own retry.
  await admin.route(inboxPath, async (route) => {
    const response = await route.fetch();
    if (!fail) return route.fulfill({ response });
    expect(response.status()).toBe(200);
    const body = await response.json() as components["schemas"]["ActionInboxResponse"];
    if (body.items.length === 0) {
      body.items.push({
        id: "account_security:healthy-source", kind: "account_security", title: "정상 소스의 보안 업무", ref: "", lane: "turn",
        urg: "wait", dueTone: "neutral", done: false, days_remaining: null, links: [{ kind: "account", id: "healthy-source" }],
      });
      body.total = Math.max(body.total, 1);
      body.counts.turn = { total: 1, total_is_exact: false };
    }
    healthyTitle = body.items[0]!.title;
    await route.fulfill({ response, json: {
      ...body, has_work: true, unavailable: [{ source: "hr_requests", support_reference: supportReference }], total_is_exact: false,
      counts: Object.fromEntries(Object.entries(body.counts).map(([key, count]) => [key, { ...count, total_is_exact: false }])),
    } });
  });
  const reads = counter(admin, /^\/api\/v1\/me\/action-inbox(\?|$)/);
  await admin.reload();
  const inbox = admin.getByRole("region", { name: "업무함", exact: true });
  const failed = inbox.getByRole("alert").filter({ hasText: "변경 요청 업무를 불러오지 못했습니다." });
  await expect(failed).toBeVisible();
  await expect(failed).toContainText(`지원 문의 번호 ${supportReference}`);
  await expect(inbox.getByRole("row").filter({ hasText: healthyTitle }).first()).toBeVisible();
  await expect(inbox.getByRole("heading", { name: "불러오지 못했습니다", exact: true })).toHaveCount(0);
  await expect(inbox.getByRole("heading", { name: "처리할 업무가 없습니다" })).toHaveCount(0);
  await expect(inbox.getByRole("heading", { name: "이 계정으로 처리할 업무가 없습니다" })).toHaveCount(0);
  await expect(inbox.getByRole("group", { name: "업무 구분" }).getByRole("button")).toHaveCount(5);
  await walkHome(admin, "partial", info);

  fail = false;
  const asked = reads();
  await failed.getByRole("button", { name: "다시 불러오기" }).click();
  await expect.poll(reads).toBeGreaterThan(asked);
  await expect(failed).toBeHidden();
  await expect(inbox.getByText(`지원 문의 번호 ${supportReference}`, { exact: true })).toHaveCount(0);
  await admin.unroute(inboxPath);
  await admin.route(inboxPath, (route) => route.fulfill(refused));
  const deniedReads = counter(admin, /^\/api\/v1\/me\/action-inbox(\?|$)/);
  await admin.reload();
  await expect(inbox.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
  await expect(inbox.getByRole("heading", { name: "처리할 업무가 없습니다" })).toHaveCount(0);
  await expectAccessible(admin, "Home with a refused unified inbox");
  await admin.waitForTimeout(3_000);
  expect(deniedReads(), "a refused queue is asked once, not retried").toBe(1);
  await admin.unroute(inboxPath);

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

test("an account with no work grant gets an honest home, and 기간 잠금 refuses it once", { tag: "@hr" }, async ({ browser }, info) => {
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

  // The endpoint succeeds with no refused-source items: the browser does not discover access by reading every source.
  await go(exec, "/");
  const inboxRead = exec.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/me/action-inbox");
  const ownAccount = exec.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/users/me");
  await exec.reload();
  const response = await inboxRead;
  expect(response.status()).toBe(200);
  const me = await (await ownAccount).json() as { id: string };
  const body = await response.json() as { items: { kind: string; links: { kind: string; id: string }[] }[] };
  expect(body.items).toEqual([expect.objectContaining({
    kind: "account_security", links: [expect.objectContaining({ kind: "account", id: me.id })],
  })]);
  const inbox = exec.getByRole("region", { name: "업무함", exact: true });
  await expect(inbox.getByRole("heading", { name: "이 계정으로 처리할 업무가 없습니다", exact: true })).toBeVisible();
  await expect(inbox.getByRole("link", { name: "내 계정", exact: true })).toHaveAttribute("href", "/account");
  await expect(inbox.getByRole("button", { name: "패스키 등록", exact: true })).toBeVisible();
  await expect(inbox).not.toContainText("이임원");
  await expect(inbox.getByRole("group", { name: "업무 구분" }).getByRole("button")).toHaveCount(0);
  await expect(inbox.getByRole("link", { name: "직원 등록", exact: true })).toHaveCount(0);
  await expect(exec.getByRole("button", { name: "로그아웃" })).toHaveCount(1);
  await walkHome(exec, "no-grant", info);
});
