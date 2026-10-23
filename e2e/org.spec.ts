import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, proposal } from "./flows";
import { tenantWithExecutive } from "./setup-flows";
import { revealUnit } from "./structure-flows";

// The change record (the HCM journey covers the one-step Home path): keep a draft, re-date it, submit it from its
// page, a rejection that requires the approver's reason, and a redraft that keeps the content but not the date.
// 결재 is off by default (decisions #26: approval.policy.org_structure = none) and no one holds settings_manage yet, so
// a test cannot turn it on: this rejection/redraft journey waits for a tenant 결재 정책 (the engine stays covered
// by the backend tests that pin route).
test.fixme("an org change is drafted, submitted from its page, rejected with a reason and redrafted", { tag: "@org" }, async ({ browser }) => {
  const { admin, exec } = await tenantWithExecutive(browser, "orgco", "조직주식회사");

  // Once operating, the chart's add gesture opens the governed proposal beside it (decisions #18: regions retired).
  await go(admin, "/org");
  await revealUnit(admin, "본점");
  await admin.keyboard.press("a");
  const card = proposal(admin);
  await expect(card.getByRole("heading", { name: "본점 아래에 부서 신설", level: 2 })).toBeFocused();
  await expectAccessible(admin, "propose department card");
  await card.getByLabel("부서 이름").fill("영남권");
  await card.getByRole("button", { name: /^오늘/ }).click();
  await card.getByLabel("사유").fill("영남 거점 검토");
  await card.getByRole("button", { name: "임시 저장" }).click();

  // The draft names what it changes, and shows its own preflight without a click. No precheck step on the rail.
  await expect(admin.getByRole("heading", { name: "영남권 신설", level: 1 })).toBeVisible();
  await expect(admin.getByText(/부서 신설 — .*영남권/).first()).toBeVisible();
  await expect(admin.getByRole("region", { name: "사전 점검" })).toContainText("통과");
  await expect(admin.locator(".rail-steps__item")).toHaveText(["초안", "결재 0/4", "승인", /^시행 /]);
  await expectAccessible(admin, "org change page (draft)");

  // Re-dating starts from an empty date: nothing is chosen for the user.
  await admin.getByRole("button", { name: "시행일·사유 수정" }).click();
  await expect(admin.getByRole("textbox", { name: /^시행일/ })).toHaveValue("");
  await admin.getByRole("button", { name: /^다음 주 월요일/ }).click();
  await admin.getByRole("button", { name: "임시 저장" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "초안을 고쳤습니다" })).toBeVisible();

  // Submitted from the page in one click; the drafter is told they cannot decide or withdraw it.
  await admin.getByRole("button", { name: "영남권 신설 상신" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "영남권 신설을 상신했습니다" })).toBeVisible();
  await expect(admin.locator('.rail-steps [aria-current="step"]')).toHaveText("결재 0/4");
  await expect(admin.getByText(/기안자는 결재할 수 없습니다/)).toBeVisible();
  await expect(admin.getByRole("complementary", { name: "기록" })).toContainText("운영 계정님이 조직 변경을 상신했습니다");

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
  await stale.goto(admin.url());
  await expect(stale.getByRole("button", { name: "인사 단계 승인 (1/4)" })).toBeEnabled();

  // The approver sees what is decided above the decision; rejecting needs a reason.
  await go(exec, admin.url());
  await expect(exec.getByRole("region", { name: "다음 할 일" })).toContainText(/부서 신설 — .*영남권/);
  await expect(exec.getByRole("button", { name: "인사 단계 승인 (1/4)" })).toBeEnabled();
  await exec.getByRole("button", { name: "반려", exact: true }).click();
  const reject = exec.getByRole("button", { name: "인사 단계 반려 (1/4)" });
  await expect(reject).toBeDisabled();
  await expect(exec.getByText("반려 사유를 적어야 반려할 수 있습니다")).toBeVisible();
  await expectAccessible(exec, "org change page (reject form)");
  // Esc never drops a typed reason on the first press.
  await exec.getByLabel("반려 사유").fill("다시 검토");
  await exec.getByLabel("반려 사유").press("Escape");
  await expect(exec.getByText("작성 중인 내용이 있습니다 · 한 번 더 누르면 닫습니다")).toBeVisible();
  await exec.getByLabel("반려 사유").press("Escape");
  await expect(reject).toBeHidden();
  await exec.getByRole("button", { name: "반려", exact: true }).click();
  await exec.getByLabel("반려 사유").fill("시행일을 다음 달로 바꿔 다시 올려 주십시오");
  await reject.click();
  await expect(exec.getByRole("status").filter({ hasText: "인사 단계를 반려했습니다" })).toBeVisible();
  await expect(exec.locator('.rail-steps__item[data-state="failed"]')).toHaveText("결재 0/4 · 반려됨");
  await expect(exec.getByText("진행 안 함")).toHaveCount(3);
  await expectAccessible(exec, "org change page (rejected)");
  // Deciding in the stale tab names who decided first and when, instead of an error or a second decision (3.7).
  await stale.getByRole("button", { name: "인사 단계 승인 (1/4)" }).click();
  await expect(stale.getByRole("status").filter({ hasText: /님이 .+에 이미 처리했습니다/ })).toBeVisible();
  await expect(stale.getByRole("button", { name: /단계 승인/ })).toHaveCount(0);
  await expect(stale.locator('.rail-steps__item[data-state="failed"]')).toHaveText("결재 0/4 · 반려됨");
  await stale.close();

  // My rejected change waits for my redraft: Home's turn leads to the reason, and the default view still lists it.
  await go(admin, "/");
  await expect(admin.getByRole("region", { name: "내가 올린 조직 변경" })).toContainText("영남권");
  await expect(admin.getByRole("link", { name: "반려 사유 보기" })).toHaveCount(1);
  await go(admin, "/org/changes");
  await expect(admin.getByRole("button", { name: "진행 중 1" })).toHaveAttribute("aria-pressed", "true");
  await expect(admin.getByRole("row", { name: /영남권 신설/ })).toContainText("반려됨");
  // The list's views carry the server's counts; the rejected change is under 반려·취소.
  await go(admin, "/org/changes?view=closed");
  await expect(admin.getByRole("button", { name: "반려·취소 1" })).toHaveAttribute("aria-pressed", "true");
  await expect(admin.getByRole("row", { name: /영남권 신설/ })).toContainText("반려됨");
  await expectAccessible(admin, "org changes list");

  // The drafter redrafts the same content: the date is chosen again, never carried over.
  await admin.getByRole("row", { name: /영남권 신설/ }).getByRole("link").click();
  await expect(admin.getByText("반려 사유: 시행일을 다음 달로 바꿔 다시 올려 주십시오")).toBeVisible();
  await admin.getByRole("button", { name: "반려 내용으로 다시 기안" }).click();
  await admin.getByRole("button", { name: "영남권 신설 다시 상신" }).click();
  await expect(admin.getByText("시행일을 선택하십시오")).toBeVisible();
  await admin.getByRole("button", { name: /^오늘/ }).click();
  await admin.getByRole("button", { name: "영남권 신설 다시 상신" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "다시 기안해 상신했습니다" })).toBeVisible();
  await expect(admin.getByRole("link", { name: /^반려된 OC-\d{4}-\d{4}의 재기안$/ })).toBeVisible();
  await expect(admin.locator('.rail-steps [aria-current="step"]')).toHaveText("결재 0/4");
  await expectAccessible(admin, "org change page (redrafted)");
  // Once redrafted, the rejected original leaves the default view; the redraft is the one in progress.
  await go(admin, "/org/changes");
  await expect(admin.getByRole("button", { name: "진행 중 1" })).toBeVisible();
  await expect(admin.getByRole("row", { name: /영남권 신설/ })).toContainText("결재 중");
  // On Home the redraft waits on others; the rejection it settles leaves my turn.
  await go(admin, "/");
  await expect(admin.getByRole("button", { name: "기다리는 중 1" })).toBeVisible();
  await expect(admin.getByRole("link", { name: "반려 사유 보기" })).toHaveCount(0);

  // The rejected 부서 was never created.
  await go(admin, "/org?view=list");
  await expect(admin.getByRole("row", { name: /영남권/ })).toHaveCount(0);
});
