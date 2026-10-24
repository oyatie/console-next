import { expect, test, type Page } from "@playwright/test";
import { OWN_ECHO_MS } from "../apps/web/src/lib/freshness";
import { expectAccessible } from "./a11y";
import { grantAccess } from "./access-flows";
import { firstSignIn, go, kstDate, option, passkeyLogin, registerEmployee, stepUp, takeCode, unique } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { letGrantsAge } from "./second-person-fixture";
import { startOperations, tenantInSetup } from "./setup-flows";

const today = kstDate();
const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
const month = new Intl.DateTimeFormat("ko-KR", { timeZone: "UTC", year: "numeric", month: "long" }).format(new Date(`${lastMonth}-15T00:00:00Z`));
const LOCKS = "/people/period-locks";

async function lockPayroll(admin: Page) {
  await go(admin, LOCKS);
  await option(admin, "업무 영역", "급여").click();
  await admin.getByRole("combobox", { name: /^월/ }).selectOption(lastMonth);
  await option(admin, "잠금 사유", "월 급여 마감").click();
  await admin.getByRole("button", { name: `급여 ${month} 잠금` }).click();
  await expect(admin.getByRole("status").filter({ hasText: `급여 ${month} 기간을 잠갔습니다` })).toBeVisible();
}

/** The requester's unlock, reason and time box, ending in the waiting receipt. */
async function requestUnlock(admin: Page) {
  const row = admin.getByRole("row", { name: /월 급여 마감/ });
  await row.getByRole("button", { name: `급여 ${month} 잠금 해제` }).click();
  const dialog = admin.getByRole("dialog", { name: `급여 ${month} 잠금 해제` });
  await option(admin, "해제 사유", "소급 정정").click();
  await dialog.getByLabel("해제 메모").fill("8월 급여 소급분 반영");
  await dialog.getByRole("button", { name: /^3일 동안/ }).click();
  await dialog.getByRole("button", { name: "패스키로 확인하고 잠금 해제" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "잠금 해제를 요청했습니다" })).toContainText("다른 마감 권한자가 패스키로 확인하면 해제됩니다");
  await expect(row).toContainText("승인 대기");
  return row;
}

// BW-15 second person (P0: an unlock waiting for another close authority had no screen to approve it, so it sat until it
// expired). The close authority is made on the 권한 screen and confirms the grant's notice on Home (decisions D0.2,
// 155: before both, the two-person rule never applied in a UI-built tenant). The requester waits and sees the outcome
// live; the second person finds it on Home and on the lock page, refuses it with a reason, then approves a new request
// with their own passkey. Refusals change nothing.
test("period unlock: a second close authority refuses, then approves; the requester sees each outcome", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(8 * 60_000); // two tenants, verified close authorities and two passkey decisions, all through the UI
  const slug = "unlockco";
  // The setup's colleague holds nothing: the lower-grant account below.
  const { admin: operator, exec: nobody } = await tenantInSetup(browser, slug, "해제주식회사", false, "본사", "none");
  // Both acts need verified people: the bootstrap operator has no employee record link.
  const authorities: Page[] = [];
  for (const [name, number] of [["이요청", "UL-0001"], ["김마감", "UL-0002"]]) {
    await registerEmployee(operator, { name: name!, number: number!, hired: "2024-03-04", unit: "본사" });
    await operator.getByRole("button", { name: "계정 초대" }).click();
    await stepUp(operator.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", operator.getByLabel("일회용 코드"));
    authorities.push(await firstSignIn(browser, await takeCode(operator)));
  }
  const [admin, exec] = authorities as [Page, Page];
  await startOperations(operator);
  for (const [page, name] of [[admin, "이요청"], [exec, "김마감"]] as const) {
    await grantAccess(operator, name, "close");
    // A changed grant ends sessions; the authority signs in and acknowledges its notice.
    await go(page, "/", true);
    await passkeyLogin(page);
    await page.reload();
    const notices = page.getByRole("region", { name: "업무함", exact: true }).getByRole("listitem").filter({ has: page.getByRole("button", { name: "기간 마감 부여 확인 기록", exact: true }) });
    await expect(notices).toContainText("기간 마감 · 전체 ·", { timeout: 20_000 });
    await expectAccessible(page, "grant notice");
    await notices.getByRole("button", { name: "기간 마감 부여 확인 기록" }).click();
    await expect(page.getByRole("status").filter({ hasText: "기간 마감 부여 확인을 기록했습니다" })).toBeVisible();
    await expect(notices).toBeHidden();
    letGrantsAge(unique(slug), name);
  }
  // A frame within OWN_ECHO_MS of this tab's own write is that write's echo (lib/live): the requester acts after it.
  await exec.waitForTimeout(OWN_ECHO_MS);

  // The linked requester locks last month, then asks to unlock it; another authority decides.
  const adminBearer = bearerOf(admin);
  await lockPayroll(admin);
  const row = await requestUnlock(admin);

  // The requester sees the request and whose turn it is, never a decision of their own.
  await row.getByRole("button", { name: `급여 ${month} 해제 요청 보기` }).click();
  const mine = admin.getByRole("dialog", { name: `급여 ${month} 잠금 해제 요청` });
  await expect(mine).toContainText("다른 마감 권한자 1명이 승인하거나 반려합니다");
  await expect(mine).toContainText("소급 정정 · 8월 급여 소급분 반영");
  await expect(mine.getByRole("button", { name: /승인/ })).toHaveCount(0);
  await expectAccessible(admin, "unlock request (requester)");
  await mine.getByRole("button", { name: "돌아가기" }).click();

  // Refusals at the server, none of which changes anything: the requester, an account with no grant, another tenant.
  const api = apiOf(admin, adminBearer);
  const lock = ((await (await api("/period-locks?active=true")).json()) as { items: { id: string; unlockRequest?: { id: string; status: string } }[] }).items[0]!;
  const requestId = lock.unlockRequest!.id;
  const own = await api(`/period-locks/${lock.id}/unlock/reject`, "POST", { requestId, note: "본인 반려" });
  expect([own.status(), await codeOf(own)]).toEqual([403, "second_person_required"]);
  const operatorBearer = bearerOf(operator);
  await go(operator, LOCKS);
  await expect.poll(operatorBearer, { timeout: 15_000 }).not.toBe("");
  const unboundOperator = await apiOf(operator, operatorBearer)(`/period-locks/${lock.id}/unlock/reject`, "POST", { requestId, note: "운영 계정 반려" });
  expect([unboundOperator.status(), await codeOf(unboundOperator)]).toEqual([403, "period_unlock.refuse.identity_unbound"]);
  const nobodyBearer = bearerOf(nobody);
  await go(nobody, LOCKS);
  await expect(nobody.getByText("기간 잠금을 볼 권한이 없습니다")).toBeVisible();
  await expect.poll(nobodyBearer, { timeout: 15_000 }).not.toBe("");
  const lower = await apiOf(nobody, nobodyBearer)(`/period-locks/${lock.id}/unlock/reject`, "POST", { requestId, note: "권한 없음" });
  expect(lower.status()).toBe(403);
  const outsider = await openTenant(browser, "unlockother", "다른주식회사");
  const outsiderBearer = bearerOf(outsider);
  await go(outsider, LOCKS);
  await expect(outsider.getByRole("heading", { name: "기간 잠금", level: 1 })).toBeVisible();
  await expect.poll(outsiderBearer, { timeout: 15_000 }).not.toBe("");
  const foreign = await apiOf(outsider, outsiderBearer)(`/period-locks/${lock.id}/unlock/reject`, "POST", { requestId, note: "다른 회사" });
  expect(foreign.status()).toBe(404);
  const still = ((await (await api("/period-locks?active=true")).json()) as { items: { unlockRequest?: { status: string } }[] }).items[0]!;
  expect(still.unlockRequest?.status).toBe("PENDING");
  await expect(row).toContainText("승인 대기");

  // The second person, on Home all along, sees the request arrive live and refuses it with a reason,
  // after the requester's own-write window (OWN_ECHO_MS), as people do.
  await exec.waitForTimeout(OWN_ECHO_MS);
  const inbox = exec.getByRole("region", { name: "업무함", exact: true });
  const queue = inbox.getByRole("listitem").filter({ has: exec.locator(`a[href="${LOCKS}?review=${lock.id}"]`) });
  await expect(queue).toContainText(`급여 ${month}`);
  await expect(queue).toContainText("이요청");
  await expect(queue).toContainText("소급 정정");
  await queue.getByRole("link", { name: `급여 ${month} 해제 요청 검토`, exact: true }).click();
  const card = exec.getByRole("dialog", { name: `급여 ${month} 잠금 해제 요청` });
  await expect(card).toContainText("내 차례입니다");
  await expect(card).toContainText("이요청 ·");
  await expectAccessible(exec, "unlock request (second person)");
  await card.getByRole("button", { name: "반려", exact: true }).click();
  await card.getByRole("button", { name: "잠금 해제 반려" }).click(); // a check: no reason yet, nothing is sent
  await expect(card).toContainText("반려 사유를 입력하십시오");
  await card.getByLabel(/^반려 사유/).fill("9월 급여 확정 뒤 다시 요청");
  // Identity may become unavailable after the list was read; show the server refusal in this dialog.
  const rejectRoute = `**/api/v1/period-locks/${lock.id}/unlock/reject`;
  await exec.route(rejectRoute, (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "period_unlock.refuse.identity_unbound", message: "identity unavailable" } }) }));
  await card.getByRole("button", { name: "잠금 해제 반려" }).click();
  await expect(card.getByRole("alert")).toContainText("요청자 또는 결정자의 본인 정보를 확인할 수 없어 거부했습니다");
  await expect(card.getByRole("alert")).toContainText("계정 관리 권한이 있는 담당자에게 계정을 인사카드에 연결하거나 동일인 확인을 완료해 달라고 요청하십시오");
  await expect(row).toContainText("승인 대기");
  await exec.unroute(rejectRoute);
  await card.getByRole("button", { name: "잠금 해제 반려" }).click();
  await expect(card).toBeHidden();
  await expect(exec.getByRole("status").filter({ hasText: `급여 ${month} 잠금 해제 요청을 반려했습니다` })).toBeVisible();

  // The requester's page follows without a reload: still locked, refused, and why.
  await expect(row).toContainText("반려됨");
  await row.getByRole("button", { name: `급여 ${month} 해제 요청 보기` }).click();
  await expect(mine).toContainText("김마감님이");
  await expect(mine).toContainText("9월 급여 확정 뒤 다시 요청");
  await expectAccessible(admin, "unlock request (refused)");
  await mine.getByRole("button", { name: "돌아가기" }).click();

  // A new request, and the second person approves it with their own passkey. The live stream takes any frame within
  // OWN_ECHO_MS of a tab's own write as that write's echo (lib/live), so each acts after the other's window, as people do.
  await admin.waitForTimeout(OWN_ECHO_MS);
  await requestUnlock(admin);
  await exec.waitForTimeout(OWN_ECHO_MS);
  await exec.getByRole("button", { name: `급여 ${month} 해제 요청 검토` }).click();
  await card.getByRole("button", { name: "패스키로 확인하고 잠금 해제 승인" }).click();
  await expect(exec.getByRole("status").filter({ hasText: `급여 ${month} 잠금 해제를 승인했습니다` })).toBeVisible();

  // The requester sees it open, approved by the second person, with nothing flagged for review.
  await expect(admin.getByRole("heading", { name: "잠긴 기간 0건" })).toBeVisible();
  await admin.getByRole("button", { name: "해제됨 1" }).click();
  const opened = admin.getByRole("row", { name: /월 급여 마감/ });
  await expect(opened).toContainText("다른 마감 권한자가 확인함");
  await expect(opened).not.toContainText("사후 검토 필요");
});

test("setup with ops and one linked close authority unlocks with review; go-live closes the solo path", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const slug = "unlocksolo";
  const { admin: operator } = await tenantInSetup(browser, slug, "단독마감회사", false, "본사", "none");
  await registerEmployee(operator, { name: "단독마감", number: "UL-0003", hired: "2024-03-04", unit: "본사" });
  await operator.getByRole("button", { name: "계정 초대" }).click();
  await stepUp(operator.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", operator.getByLabel("일회용 코드"));
  const human = await firstSignIn(browser, await takeCode(operator));
  await grantAccess(operator, "단독마감", "full");
  await go(human, "/", true);
  await passkeyLogin(human);
  const notice = human.getByRole("region", { name: "업무함", exact: true }).getByRole("listitem").filter({ has: human.getByRole("button", { name: "전체 업무 부여 확인 기록", exact: true }) });
  await notice.getByRole("button", { name: "전체 업무 부여 확인 기록" }).click();
  await expect(notice).toBeHidden();
  letGrantsAge(unique(slug), "단독마감");
  const bearer = bearerOf(human);
  await lockPayroll(human);
  const row = human.getByRole("row", { name: /월 급여 마감/ });
  await row.getByRole("button", { name: `급여 ${month} 잠금 해제` }).click();
  const dialog = human.getByRole("dialog", { name: `급여 ${month} 잠금 해제` });
  await option(human, "해제 사유", "소급 정정").click();
  await dialog.getByLabel("해제 메모").fill("설정 중 급여 확인");
  await dialog.getByRole("button", { name: /^3일 동안/ }).click();
  const response = human.waitForResponse((r) => r.url().endsWith("/unlock") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "패스키로 확인하고 잠금 해제" }).click();
  const unlocked = await response;
  expect(unlocked.status()).toBe(200);
  const outcome = await unlocked.json();
  expect(outcome.lock.unlockReviewRequired).toBe(true);
  expect(outcome.exception.id).toBeTruthy();
  await expect(dialog).toBeHidden();
  await startOperations(operator);
  await lockPayroll(human);
  const api = apiOf(human, bearer);
  const { items } = await (await api("/period-locks?active=true")).json();
  const { id } = items[0];
  const refused = await api(`/period-locks/${id}/unlock`, "POST", { reasonCode: "RETRO_CORRECTION", note: "운영 시작 뒤 단독 요청", relockAt: new Date(Date.now() + 86_400_000).toISOString() });
  expect([refused.status(), await codeOf(refused)]).toEqual([409, "period_unlock_sole_holder_refused"]);
});
