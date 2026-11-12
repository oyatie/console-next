// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api/schema";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { firstSignIn, go, kstDate, routeReady, stepUp, takeCode } from "./flows";
import { answer, SETUP_DEPARTMENT, setupCompany, startOperations } from "./setup-flows";
import { grantAccess } from "./access-flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { leaveScreen, revealUnit } from "./structure-flows";

// The change record (the HCM journey covers the one-step Home path): keep a draft, re-date it, submit it from its
// page, a rejection that requires the approver's reason, and a redraft that keeps the content but not the date.
// Settings ops authority: 7e5b152c1b; canonical composer actions: fe381d352f.
// Inline chart creation: 975c67d1bb; person separation of duties: c7ab99e846.
test("an org change is drafted, submitted from its page, rejected with a reason and redrafted", { tag: "@org" }, async ({ browser }) => {
  const operator = await openTenant(browser, "orgco", "조직주식회사");
  const token = bearerOf(operator);
  await setupCompany(operator, "조직주식회사");
  await startOperations(operator);
  const api = apiOf(operator, token);
  const policy = await api("/settings/approval.policy.org_structure", "POST", { value: "route", reason_code: "POLICY_REVIEW" });
  expect(policy.status(), await policy.text()).toBe(201);
  const units = await api("/org-units");
  expect(units.status()).toBe(200);
  const department = (await units.json()).items.find((unit: { name: string }) => unit.name === SETUP_DEPARTMENT);
  expect(department).toBeTruthy();
  const entities = await api("/legal-entities");
  expect(entities.status()).toBe(200);
  const entity = (await entities.json()).items[0];
  const workplace = entity.workplaces[0];
  expect(workplace.default_branch_id).toBeTruthy();
  // Seed employees through the real registration API; invites and grants still use product controls.
  // Both sides of a governed decision need distinct, verified natural-person identities.
  const people: Page[] = [];
  for (const name of ["김기안", "이임원"]) {
    const registered = await api("/employees", "POST", {
      name, hire_date: kstDate(), org_unit_id: department.id, idempotency_key: crypto.randomUUID(),
      legal_entity_id: entity.id, workplace_id: workplace.id, home_branch_id: workplace.default_branch_id,
    });
    expect(registered.status(), await registered.text()).toBe(201);
    const person = await registered.json() as components["schemas"]["EmployeeDetail"];
    await go(operator, `/people/${person.employee.id}`);
    await operator.getByRole("button", { name: "계정 초대" }).click();
    await stepUp(operator.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", operator.getByLabel("일회용 코드"));
    const code = await takeCode(operator);
    await grantAccess(operator, name, "org");
    people.push(await firstSignIn(browser, code));
  }
  const [admin, exec] = people as [Page, Page];
  for (const page of [admin, exec]) {
    await page.bringToFront();
    await routeReady(page, "/");
    await leaveScreen(page);
  }

  // Open the full proposal beside the chart to save a draft before submitting it.
  await admin.bringToFront();
  await go(admin, "/org");
  await revealUnit(admin, "본점");
  await expect.poll(() => new URL(admin.url()).searchParams.get("sel")).toBeTruthy();
  await go(admin, `/org?sel=${new URL(admin.url()).searchParams.get("sel")}&act=dept-add`);
  const card = admin.getByRole("dialog", { name: "부서 신설", exact: true });
  await expect(card.getByRole("heading", { name: "부서 신설", exact: true })).toBeVisible();
  await expect.poll(() => card.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await checkScreen(admin, "propose department card");
  await card.getByLabel("부서 이름").fill("영남권");
  await card.getByRole("button", { name: /^오늘/ }).click();
  await card.getByLabel("사유").fill("영남 거점 검토");
  const drafted = answer(admin, "POST", /^\/api\/v1\/org-changes$/);
  await card.getByRole("button", { name: "임시 저장" }).click();
  expect((await drafted).status()).toBe(201);

  // The draft names what it changes, and shows its own preflight without a click. No precheck step on the rail.
  await expect(admin.getByRole("heading", { name: "영남권 신설", level: 1 })).toBeVisible();
  await expect(admin.getByText(/부서 신설 — .*영남권/).first()).toBeVisible();
  await expect(admin.getByRole("region", { name: "사전 점검" })).toContainText("통과");
  await expect(admin.locator('.rail-steps [aria-current="step"]')).toHaveText("작성");
  await checkScreen(admin, "org change page (draft)");

  // Re-dating starts from an empty date: nothing is chosen for the user.
  await admin.getByRole("button", { name: "적용일·사유 변경" }).click();
  await expect(admin.getByRole("textbox", { name: /^새 적용일/ })).toHaveValue("");
  await admin.getByRole("button", { name: /^다음 주 월요일/ }).click();
  const edited = answer(admin, "PATCH", /^\/api\/v1\/org-changes\/[^/]+$/);
  await admin.getByRole("button", { name: "조직 변경 변경", exact: true }).click();
  expect((await edited).status()).toBe(200);
  await expect(admin.getByRole("status").filter({ hasText: "초안을 고쳤습니다" })).toBeVisible();

  // Submitted from the page in one click; the drafter is told they cannot decide it.
  const submitted = answer(admin, "POST", /\/org-changes\/[^/]+\/submit$/);
  await admin.getByRole("button", { name: "조직 변경 결재 요청" }).click();
  expect((await submitted).status()).toBe(200);
  await expect(admin.getByRole("status").filter({ hasText: "영남권 신설을 상신했습니다" })).toBeVisible();
  await expect(admin.locator('.rail-steps [aria-current="step"]')).toHaveText("결재 0/4");
  await expect(admin.getByText(/기안자는 결재할 수 없습니다/)).toBeVisible();
  await expect(admin.getByRole("complementary", { name: "기록" })).toContainText("김기안님이 조직 변경을 상신했습니다");
  const changeUrl = admin.url();

  // A second tab of the same approver keeps showing the step as open (its re-reads are held back until it decides).
  const stale = await exec.context().newPage();
  let held: string | undefined;
  let live = false;
  stale.on("request", (r) => void (r.url().includes("/decision") && (live = true)));
  await stale.route(/\/api\/v1\/org-changes\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (held && !live) return route.fulfill({ status: 200, contentType: "application/json", body: held });
    const res = await route.fetch();
    const body = await res.text();
    held ??= body;
    return route.fulfill({ response: res, body });
  });
  await stale.bringToFront();
  await stale.goto(changeUrl);
  await expect(stale.getByRole("button", { name: "조직 변경 승인" })).toBeEnabled();
  await admin.bringToFront();
  await go(admin, "/org/changes");
  await expect(admin.getByRole("row", { name: /영남권 신설/ })).toContainText("결재 중");

  // The approver sees what is decided above the decision; rejecting needs a reason.
  await exec.bringToFront();
  await go(exec, changeUrl);
  await expect(exec.getByRole("region", { name: "다음 할 일" })).toContainText(/부서 신설 — .*영남권/);
  await expect(exec.getByRole("button", { name: "조직 변경 승인" })).toBeEnabled();
  await exec.getByRole("button", { name: "조직 변경 반려", exact: true }).click();
  const reject = exec.getByRole("button", { name: "조직 변경 반려" });
  await expect(reject).toBeDisabled();
  await expect(exec.getByText("반려 사유를 적어야 반려할 수 있습니다")).toBeVisible();
  await checkScreen(exec, "org change page (reject form)");
  // Esc never drops a typed reason on the first press.
  await exec.getByLabel("반려 사유").fill("다시 검토");
  await exec.getByLabel("반려 사유").press("Escape");
  await expect(exec.getByText("작성 중인 내용이 있습니다 · 한 번 더 누르면 닫습니다")).toBeVisible();
  await exec.getByLabel("반려 사유").press("Escape");
  await expect(exec.getByLabel("반려 사유")).toBeHidden();
  await exec.getByRole("button", { name: "조직 변경 반려", exact: true }).click();
  await exec.getByLabel("반려 사유").fill("시행일을 다음 달로 바꿔 다시 올려 주십시오");
  const rejected = answer(exec, "POST", /\/approval-steps\/[^/]+\/decision$/);
  await reject.click();
  expect((await rejected).status()).toBe(200);
  await expect(exec.getByRole("status").filter({ hasText: "인사 단계를 반려했습니다" })).toBeVisible();
  await expect(exec.locator('.rail-steps__item[data-state="failed"]')).toHaveText("결재 0/4 · 반려됨");
  await expect(exec.getByText("진행 안 함")).toHaveCount(3);
  await checkScreen(exec, "org change page (rejected)");
  // Deciding in the stale tab names who decided first and when, instead of an error or a second decision (3.7).
  await stale.bringToFront();
  const conflict = answer(stale, "POST", /\/approval-steps\/[^/]+\/decision$/);
  await stale.getByRole("button", { name: "조직 변경 승인" }).click();
  expect((await conflict).status()).toBe(409);
  await expect(stale.getByRole("status").filter({ hasText: /님이 .+에 이미 처리했습니다/ })).toBeVisible();
  await expect(stale.getByRole("button", { name: "조직 변경 승인", exact: true })).toHaveCount(0);
  await expect(stale.locator('.rail-steps__item[data-state="failed"]')).toHaveText("결재 0/4 · 반려됨");
  await stale.close();

  // My rejected change waits for my redraft: Home's turn leads to the reason, and the default view still lists it.
  await admin.bringToFront();
  await go(admin, "/");
  await expect(admin.getByRole("region", { name: "업무함", exact: true })).toContainText("영남권");
  await expect(admin.getByRole("link", { name: "반려 사유 보기" })).toHaveCount(1);
  await go(admin, "/org/changes");
  await expect(admin.getByRole("button", { name: "진행 중 1" })).toHaveAttribute("aria-pressed", "true");
  await expect(admin.getByRole("row", { name: /영남권 신설/ })).toContainText("반려됨");
  // The list's views carry the server's counts; the rejected change is under 반려·취소.
  await go(admin, "/org/changes?view=closed");
  await expect(admin.getByRole("button", { name: "반려·취소 1" })).toHaveAttribute("aria-pressed", "true");
  await expect(admin.getByRole("row", { name: /영남권 신설/ })).toContainText("반려됨");
  await checkScreen(admin, "org changes list");

  // The drafter redrafts the same content: the date is chosen again, never carried over.
  await admin.getByRole("row", { name: /영남권 신설/ }).getByRole("link").click();
  await expect(admin.getByText("반려 사유: 시행일을 다음 달로 바꿔 다시 올려 주십시오")).toBeVisible();
  await admin.getByRole("button", { name: "반려 내용으로 다시 기안" }).click();
  await admin.getByRole("button", { name: "조직 변경 결재 요청" }).click();
  await expect(admin.getByText("적용일을 선택하십시오")).toBeVisible();
  await admin.getByRole("button", { name: /^오늘/ }).click();
  const redrafted = answer(admin, "POST", /\/org-changes\/[^/]+\/submit$/);
  await admin.getByRole("button", { name: "조직 변경 결재 요청" }).click();
  expect((await redrafted).status()).toBe(200);
  await expect(admin.getByRole("status").filter({ hasText: "다시 기안해 상신했습니다" })).toBeVisible();
  await expect(admin.getByRole("link", { name: /^반려된 OC-\d{4}-\d{4}의 재기안$/ })).toBeVisible();
  await expect(admin.locator('.rail-steps [aria-current="step"]')).toHaveText("결재 0/4");
  await checkScreen(admin, "org change page (redrafted)");
  // Once redrafted, the rejected original leaves the default view; the redraft is the one in progress.
  await go(admin, "/org/changes");
  await expect(admin.getByRole("button", { name: "진행 중 1" })).toBeVisible();
  await expect(admin.getByRole("row", { name: /영남권 신설/ })).toContainText("결재 중");
  // In the inbox the redraft waits on others; the rejection it settles leaves my turn.
  await go(admin, "/inbox?tab=waiting");
  await expect(admin.getByRole("link", { name: "요청한 일 1" })).toHaveAttribute("aria-current", "page");
  await expect(admin.getByRole("link", { name: "반려 사유 보기" })).toHaveCount(0);

  // The rejected 부서 was never created.
  await go(admin, "/org?view=list");
  await expect(admin.getByRole("row", { name: /영남권/ })).toHaveCount(0);
});

async function checkScreen(page: Page, context: string) {
  await expectAccessible(page, context);
  const theme = await page.locator("html").getAttribute("data-theme");
  await atPhoneWidth(page, async () => {
    for (const value of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, value);
      await fits(page, context);
      await page.screenshot({ path: test.info().outputPath(`${context}-${value}.png`) });
    }
  });
  await page.locator("html").evaluate((el, value) => { if (value === null) delete el.dataset.theme; else el.dataset.theme = value; }, theme);
}
