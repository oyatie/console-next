import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantOnboardSubmit, tenantSlugField, firstSignIn, go, kstDate, option, registerEmployee, routeReady, takeCode, unique, vendorPage } from "./flows";
import { REGISTRATION_FIXTURES, acceptSetupTerms, setupCompany, setupRail, brnDisplay } from "./setup-flows";
import { signOff } from "./sheet";

// Decisions #26 for a one-person tenant (solo ops, empty DB, no helper account): 결재 is off by default, so setup
// asks for no approver, 운영 시작 asks for no sole-approver tick, and an exit closes with the same person confirming
// for HR and for HQ. regression (W09, W10): each of these was a dead end or a 결재 the tenant never routes.
// The route leg (a second person; ops break-glass with a passkey) is proven by the backend tests: no screen can turn
// approval.policy.exit on yet (settings_manage), see e2e/org.spec.ts. After go-live the ops account also corrects a
// 사업자등록번호 itself with its passkey (item d); the refusal anyone else gets is shown with whom to ask.
test("a solo ops account registers a person and closes their exit alone, with no 결재 on the way", { tag: ["@first-run", "@regression"] }, async ({ browser }) => {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("혼자상사");
  await tenantSlugField(v).fill(unique("solo26"));
  await tenantOnboardSubmit(v).click();
  const admin = await firstSignIn(browser, await takeCode(v));

  // The setup rail names no 결재선 and promises no 결재 after go-live.
  const rail = setupRail(admin);
  await expect(rail).toContainText("법인 등록"); // the server's steps have loaded
  await expect(rail).not.toContainText("결재");
  await setupCompany(admin, "혼자상사", "본사");
  await go(admin, "/");
  await expect(rail).toContainText("직원 등록");
  await expect(rail).not.toContainText("결재");

  // 운영 시작: nothing to tick for being alone, and nothing after it waits for an approver.
  await go(admin, "/setup/go-live");
  await expect(admin.getByRole("heading", { name: "운영 시작", level: 1 })).toBeVisible();
  // The preview has loaded once its start button shows (enabled or with its reason).
  const start = admin.getByRole("button", { name: "운영 시작", exact: true });
  await expect(start).toBeVisible();
  await acceptSetupTerms(admin);
  // What becomes governed is on screen; nothing blocks and nothing asks for a tick.
  await expect(admin.getByText("법인·등록 번호 정정은 사유를 남기고 패스키로 본인 확인을 거칩니다")).toBeVisible();
  await expect(admin.getByLabel(/본인뿐인 채로 운영을 시작합니다/)).toHaveCount(0);
  await expect(admin.getByRole("main")).not.toContainText("결재");
  await expectAccessible(admin, "D26: go-live preview with no sole-approver tick");
  await expect(start).not.toHaveAttribute("aria-disabled", "true");
  await start.click();
  await expect(admin).toHaveURL(/\/$/);
  await routeReady(admin);
  await expect(setupRail(admin)).toBeHidden();
  const inbox = admin.getByRole("region", { name: "업무함", exact: true });
  await expect(inbox.getByRole("listitem")).toHaveCount(1);
  await expect(inbox.getByRole("button", { name: "패스키 등록", exact: true })).toBeVisible();
  await expect(admin.getByRole("main")).not.toContainText(/결재|기안/);

  // Register, report the exit, and confirm it for HR: the employee leaves at once.
  await registerEmployee(admin, { name: "홀로퇴직", number: "D26-0001", hired: "2024-03-04", unit: "본사" });
  const exitPanel = admin.getByRole("region", { name: "퇴직", exact: true });
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const sheet = admin.getByRole("dialog");
  await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(-1));
  await sheet.getByLabel("퇴직 경위").fill("개인 사정");
  await sheet.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await sheet.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
  await expect(exitPanel).toContainText("보고됨");
  await expect(exitPanel.getByRole("button", { name: "퇴직 취소" })).toBeVisible();
  await exitPanel.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
  await signOff(admin.getByRole("dialog").getByRole("group", { name: "확인 사항" }));
  await admin.getByRole("dialog").getByRole("button", { name: /퇴직 1명 (반영|예약)/ }).click();
  await expect(admin.getByRole("dialog")).toBeHidden();
  await expect(exitPanel).toContainText("인사 확인됨");
  await expect(exitPanel.getByRole("button", { name: "퇴직 취소" })).toHaveCount(0);
  await expect(exitPanel.getByRole("button", { name: "퇴직 철회" })).toBeVisible();

  // The same person confirms for HQ: offered, not refused (the old dead end said to find someone else).
  await expect(exitPanel).not.toContainText("인사 확인자는 본사 확인을 할 수 없습니다");
  await expect(exitPanel.getByRole("button", { name: "본사 퇴직 확인" })).not.toHaveAttribute("aria-disabled", "true");
  const caseHref = await exitPanel.getByRole("link", { name: "퇴직 건 열기" }).getAttribute("href");
  await go(admin, caseHref!);
  const now = admin.getByRole("region", { name: /지금/ });
  await expect(now.getByRole("heading", { name: "지금 · 본사 확인" })).toBeVisible();
  await now.getByRole("button", { name: "퇴직 본사 확인 1명 반영" }).click();
  await expect(admin.getByRole("region", { name: "퇴직" })).toContainText("본사 확인됨");
  await expect(admin.getByRole("button", { name: "퇴직 취소" })).toHaveCount(0);
  await expectAccessible(admin, "D26: exit closed for HQ by the HR confirmer");

  // Home has nothing stuck on a second person: the case waits only on its settlement.
  await go(admin, "/");
  const queue = inbox.getByRole("listitem").filter({ has: admin.locator(`a[href="${caseHref}?act=prepare_settlement"]`) });
  await expect(queue).toContainText("홀로퇴직");
  await expect(queue.getByRole("link", { name: "퇴직 정산 결재 준비", exact: true })).toBeVisible();
  await expect(inbox.getByRole("link", { name: "본사 퇴직 확인", exact: true })).toHaveCount(0);

  // decisions #26 item d: after go-live the ops account corrects a 사업자등록번호 itself, with its passkey.
  await go(admin, "/org/entities");
  await admin.getByRole("row", { name: /혼자상사/ }).click();
  // After go-live the number is locked: its only verb is the identifier correction.
  await admin.getByRole("button", { name: "등록번호 식별번호 정정", exact: true }).click();
  const brn = admin.getByRole("dialog", { name: "사업자등록번호 정정" });
  await expect(brn).toContainText("운영 계정이 정정합니다");
  await expect(brn).not.toContainText(/결재|승인된 예외/);
  await brn.getByLabel("올바른 번호").fill(REGISTRATION_FIXTURES.second.brn);
  await option(admin, "정정 사유", "입력 잘못").click();
  await brn.locator('input[type="file"]').setInputFiles({ name: "registration.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(brn.getByText(/registration\.pdf 붙임/)).toBeVisible();
  // Negative (UI): anyone but ops is refused identifier_correction_needs_exception and told whom to ask; nothing changes.
  await admin.route("**/identifier-corrections", (r) => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "identifier_correction_needs_exception", message: "after 운영 시작 an identifier correction needs an approved governed exception" } }) }), { times: 1 });
  await brn.getByRole("button", { name: "번호 정정" }).click();
  await expect(brn.getByRole("alert")).toContainText("운영 계정 담당자에게 정정을 요청하십시오");
  await expect(brn).toBeVisible();
  // Ops: the server asks for the passkey (428) and the same request goes again bound to this number.
  const answers: number[] = [];
  admin.on("response", (r) => void (r.url().includes("/identifier-corrections") && answers.push(r.status())));
  await brn.getByRole("button", { name: "번호 정정" }).click();
  await expect(brn).toBeHidden();
  expect(answers).toEqual([428, 200]);
  await expect(admin.getByText(brnDisplay(REGISTRATION_FIXTURES.second.brn)).first()).toBeVisible();
});
