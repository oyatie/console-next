// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { apiAs, soloTenant } from "./chaos";
import { firstSignIn, go, kstDate, option, passkeyLogin, registerEmployee, routeReady, stepUp, takeCode } from "./flows";
import { setupCompany, startOperations, tenantInSetup } from "./setup-flows";
import { expectAccessible } from "./a11y";

const REFRESH = "**/api/v1/auth/token/refresh";
const REPORT = "**/api/v1/hr/exit-cases";
const note = "개인 사정으로 사직 (작성 중)";
const drafts = (page: Page) => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("console.draft:")));
async function openDraft(page: Page) {
  await page.getByRole("button", { name: "퇴직 보고", exact: true }).click();
  const form = page.getByRole("dialog", { name: "퇴직 보고", exact: true });
  await form.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(30));
  await form.getByRole("textbox", { name: /^퇴직 경위/ }).fill(note);
  return form;
}
async function copyInput(page: Page) {
  // The clipboard permission differs by engine. Exercise the real button with a deterministic platform boundary.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; },
  } }));
  await page.getByRole("dialog", { name: "다시 로그인" }).getByRole("button", { name: "입력 내용 복사" }).click();
  const copied = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(copied).toContain(note);
  expect(copied).toContain(kstDate(30));
}

for (const [reason, message, passkey] of [
  ["session_expired", "로그인 시간이 만료되었습니다", true],
  ["session_revoked", "보안을 위해 세션이 종료되었습니다", true],
  ["session_passkey_reset", "관리자가 패스키를 초기화했습니다", false],
  ["session_deactivated", "계정이 비활성화되었습니다", false],
  ["session_signed_out_elsewhere", "다른 곳에서 로그아웃했습니다", true],
] as const) {
  test(`recovery ${reason}: copy, usable actions and original-key replay`, async ({ browser }) => {
    const page = await soloTenant(browser, `rec${reason.slice(8, 15).replaceAll("_", "")}`, "복구상사");
    const api = apiAs(page);
    await setupCompany(page, "복구상사");
    await startOperations(page);
    await registerEmployee(page, { name: "김복구", number: "REC-0001", hired: kstDate(-30), unit: "본점" });
    const employee = new URL(page.url()).pathname.split("/").pop()!;
    const form = await openDraft(page);
    const keys: string[] = [];
    const bodies: string[] = [];
    let denied = true;
    await page.route(REPORT, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      keys.push(route.request().headers()["idempotency-key"]!);
      bodies.push(route.request().postData()!);
      return denied ? route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthorized", message: "ended" } }) }) : route.fallback();
    });
    await page.route(REFRESH, (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: reason, message: "ended" } }) }));
    await form.getByRole("button", { name: /퇴직 보고$/ }).click();
    const recovery = page.getByRole("dialog", { name: "다시 로그인" });
    await expect(recovery).toContainText(message);
    await expect(recovery.getByRole("button", { name: "패스키로 다시 로그인" })).toHaveCount(passkey ? 1 : 0);
    await copyInput(page);
    await expectAccessible(page, `session recovery: ${reason}`);
    if (passkey) {
      denied = false;
      await page.unroute(REFRESH);
      const saved = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/hr/exit-cases");
      await recovery.getByRole("button", { name: "패스키로 다시 로그인" }).click();
      expect((await saved).ok()).toBe(true);
      await expect(form).toBeHidden();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      expect(bodies[1]).toBe(bodies[0]);
      await expect.poll(() => drafts(page)).toHaveLength(0);
      const cases = await api<{ items: unknown[] }>(`/api/v1/hr/exit-cases?employee_id=${employee}`);
      expect(cases.items).toHaveLength(1);
    } else {
      await recovery.getByRole("button", { name: "저장하지 않고 로그아웃" }).click();
      await expect(page).toHaveURL(/\/login/);
      expect(await drafts(page)).toHaveLength(0);
      expect(keys).toHaveLength(1);
    }
  });
}

test("company record without a draft never offers an empty copy after a sibling tab signs out", async ({ browser }) => {
  const page = await soloTenant(browser, "reccompany", "회사복구상사");
  await setupCompany(page, "회사복구상사");
  await go(page, "/org/entities");
  await page.getByRole("row", { name: /회사복구상사/ }).click();
  await expect(page).toHaveURL(/\/org\/entities\/[^/]+$/);
  await page.getByRole("button", { name: "대표전화 수정" }).click();
  const form = page.getByRole("dialog", { name: "대표전화 수정" });
  await option(page, "무엇을 기록합니까", "처음부터 잘못 적었습니다 · 정정").click();
  await form.getByRole("textbox", { name: /^대표전화/ }).fill("025550142");
  const typedPhone = await form.getByRole("textbox", { name: /^대표전화/ }).inputValue();
  expect(await drafts(page)).toHaveLength(0);

  const sibling = await page.context().newPage();
  await sibling.goto("/");
  await sibling.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(sibling).toHaveURL(/\/login/);
  const recovery = page.getByRole("dialog", { name: "다시 로그인" });
  await expect(recovery).toContainText("다른 곳에서 로그아웃했습니다");
  await expect(recovery.getByRole("button", { name: "입력 내용 복사" })).toHaveCount(0);
  await expect(recovery).not.toContainText("입력 내용을 복사했습니다");
  await expectAccessible(page, "company record recovery without draft");
  await recovery.getByRole("button", { name: "패스키로 다시 로그인" }).click();
  await expect(recovery).toBeHidden();
  await expect(form.getByRole("textbox", { name: /^대표전화/ })).toHaveValue(typedPhone);
});

test("exit-report draft survives close/reload, discards explicitly, and never crosses accounts", async ({ browser }) => {
  const { admin, exec } = await tenantInSetup(browser, "recpurge", "초안상사", false, "본점", "full");
  await startOperations(admin);
  await registerEmployee(admin, { name: "김초안", number: "REC-0002", hired: kstDate(-30), unit: "본점" });
  const record = new URL(admin.url()).pathname;
  let form = await openDraft(admin);
  await expect.poll(() => drafts(admin)).toHaveLength(1);
  await admin.keyboard.press("Escape");
  await admin.reload();
  await admin.getByRole("button", { name: "퇴직 보고", exact: true }).click();
  form = admin.getByRole("dialog", { name: "퇴직 보고", exact: true });
  await expect(form.getByRole("textbox", { name: /^퇴직 경위/ })).toHaveValue(note);
  await expect(form).toContainText("작성 중이던 내용을 불러왔습니다");

  // Expiry discovered on reload cannot name the account until the user signs in again.
  await admin.route(REFRESH, (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "session_idle_expired", message: "expired" } }) }));
  await admin.reload();
  await expect(admin).toHaveURL(/\/login/);
  expect(await drafts(admin)).toHaveLength(1);
  await admin.unroute(REFRESH);
  await passkeyLogin(admin);
  await go(admin, record);
  await admin.getByRole("button", { name: "퇴직 보고", exact: true }).click();
  await expect(form.getByRole("textbox", { name: /^퇴직 경위/ })).toHaveValue(note);
  await form.getByRole("button", { name: "버리기" }).click();
  await expect(form.getByRole("textbox", { name: /^퇴직 경위/ })).toHaveValue("");
  await expect.poll(() => drafts(admin)).toHaveLength(0);
  await form.getByRole("textbox", { name: /^퇴직 경위/ }).fill(note);
  await expect.poll(() => drafts(admin)).toHaveLength(1);

  // Another account signs in in a sibling tab of this same browser. No old DOM or persisted input may remain.
  const execPair = await exec.context().cookies();
  await admin.context().addCookies(execPair);
  const sibling = await admin.context().newPage();
  await sibling.goto(record);
  await expect(admin).toHaveURL(/\/login/);
  await routeReady(admin);
  expect(await drafts(admin)).toHaveLength(0);
  await expect(admin.getByText(note)).toHaveCount(0);
  await sibling.getByRole("button", { name: "퇴직 보고", exact: true }).click();
  await expect(sibling.getByRole("textbox", { name: /^퇴직 경위/ })).toHaveValue("");
});

test("S23 passkey reset and S25 deactivation deliver their actual server reasons and keep copy usable", async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin, exec } = await tenantInSetup(browser, "recreal", "세션상사", false, "본점", "full");
  await startOperations(admin);
  await registerEmployee(admin, { name: "김세션", number: "REC-0003", hired: kstDate(-30), unit: "본점" });
  const record = new URL(admin.url()).pathname;
  await go(exec, record);
  const form = await openDraft(exec);
  await admin.goto("/people?view=accounts");
  await admin.getByRole("row", { name: /이임원/ }).click();
  let panel = admin.getByRole("complementary", { name: "이임원" });
  await panel.getByRole("button", { name: "패스키 초기화" }).click();
  await stepUp(admin.getByRole("dialog", { name: "패스키 초기화" }), "패스키로 확인하고 패스키 초기화", admin.getByRole("dialog", { name: "패스키 초기화 로그인 코드" }));
  const code = await takeCode(admin);
  const refused = exec.waitForResponse((r) => r.url().endsWith("/auth/token/refresh") && r.status() === 401, { timeout: 15_000 });
  await form.getByRole("button", { name: /퇴직 보고$/ }).click();
  expect((await (await refused).json()).error.code).toBe("session_passkey_reset");
  const recovery = exec.getByRole("dialog", { name: "다시 로그인" });
  await expect(recovery).toContainText("관리자가 패스키를 초기화했습니다");
  await expect(recovery.getByRole("button", { name: "패스키로 다시 로그인" })).toHaveCount(0);
  await copyInput(exec);

  const again = await firstSignIn(browser, code);
  await go(again, record);
  const nextForm = await openDraft(again);
  await admin.goto("/people?view=accounts");
  await admin.getByRole("row", { name: /이임원/ }).click();
  panel = admin.getByRole("complementary", { name: "이임원" });
  const disabled = admin.waitForResponse((r) => r.request().method() === "POST" && /\/users\/[^/]+\/deactivate$/.test(new URL(r.url()).pathname), { timeout: 15_000 });
  await panel.getByRole("button", { name: /비활성화/ }).first().click();
  const confirm = admin.getByRole("dialog", { name: "계정 비활성화", exact: true });
  await confirm.getByRole("button", { name: "패스키로 확인하고 계정 비활성화" }).click();
  expect((await disabled).ok()).toBe(true);
  const deactivated = again.waitForResponse((r) => r.url().endsWith("/auth/token/refresh") && r.status() === 401, { timeout: 15_000 });
  await nextForm.getByRole("button", { name: /퇴직 보고$/ }).click();
  expect((await (await deactivated).json()).error.code).toBe("session_deactivated");
  const end = again.getByRole("dialog", { name: "다시 로그인" });
  await expect(end).toContainText("계정이 비활성화되었습니다");
  await expect(end.getByRole("button", { name: "패스키로 다시 로그인" })).toHaveCount(0);
  await again.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
  await end.getByRole("button", { name: "입력 내용 복사" }).click();
  await expect.poll(() => end.getByRole("textbox", { name: "입력 내용 복사" }).inputValue()).toContain(note);
});
