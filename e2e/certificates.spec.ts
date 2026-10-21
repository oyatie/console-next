// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { soloTenant, apiAs, faultNext } from "./chaos";
import { go, kstDate, firstSignIn, chooseRadio } from "./flows";
import { inviteAccount } from "./access-flows";
import { setupCompany } from "./setup-flows";
import { fillRegister, pressRegister, openRegistered } from "./helpers/register";

test("a solo HR operator configures, issues, recovers a lost answer, reissues and voids a certificate", async ({ browser }) => {
  const admin = await soloTenant(browser, "certificates", "증명서시험");
  await setupCompany(admin, "증명서시험", "본사");
  const read = apiAs(admin);
  await admin.reload();
  await go(admin, "/people/certificates");
  await admin.getByRole("button", { name: "번호·직인 설정" }).click();
  await chooseRadio(admin.getByRole("dialog"), /주식회사 증명서시험/);
  await admin.getByLabel(/^번호 접두어/).fill("HR");
  await admin.getByLabel(/^일련번호 자릿수/).fill("6");
  await admin.getByLabel(/^직인 표기/).fill("증명서시험 대표이사");
  const saved = admin.waitForResponse((r) => r.url().endsWith("/api/v1/hr/certificate-settings") && r.request().method() === "PUT");
  await admin.getByRole("button", { name: "설정 저장" }).click();
  expect((await saved).status()).toBe(200);
  await expectAccessible(admin, "certificate issuer settings");
  await admin.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await expectAccessible(admin, "certificate register after settings save");

  await go(admin, "/people/new");
  await fillRegister(admin, { name: "증명직원", hired: kstDate(), unit: "본사" });
  await pressRegister(admin);
  await openRegistered(admin, "증명직원");
  const employeeId = new URL(admin.url()).pathname.split("/").at(-1)!;
  await admin.getByRole("button", { name: "증명서", exact: true }).click();
  const sheet = admin.getByRole("dialog", { name: "증명서 발급" });
  await expect(sheet.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await chooseRadio(sheet, /재직증명서/);
  await sheet.getByRole("checkbox", { name: "사용 기간" }).locator("xpath=ancestor::label[1]").click();
  await sheet.getByLabel(/^제출 목적/).fill("은행 제출");
  await expectAccessible(admin, "certificate issuance");
  await faultNext(admin, /\/api\/v1\/hr\/certificates$/, "lost");
  await sheet.getByRole("button", { name: "발급", exact: true }).click();
  await expect(sheet.getByRole("status")).toContainText("처리 여부 확인 중");
  await sheet.getByRole("button", { name: "기록됐는지 확인", exact: true }).click();
  await admin.waitForURL(/\/people\/certificates\/[\w-]+$/);
  const original = new URL(admin.url()).pathname;
  const paper = admin.locator("[data-paper]");
  await expect(paper).toContainText("HR-");
  await expect(paper).toContainText("증명서시험 대표이사");
  await expect(paper).not.toContainText("생년월일");
  await expectAccessible(admin, "issued certificate");
  const page = await read<{ items: { id: string; certificate_no: string; name: string }[] }>("/api/v1/hr/certificates");
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).not.toHaveProperty("snapshot");
  expect(page.items[0]!.name).toBe("증명직원");

  await admin.getByRole("button", { name: "재발급", exact: true }).click();
  const reissue = admin.getByRole("dialog", { name: "재발급", exact: true });
  await reissue.getByLabel(/^사유/).fill("제출처 추가 요청");
  await faultNext(admin, /\/api\/v1\/hr\/certificates\/[\w-]+\/reissue$/, "lost");
  await reissue.getByRole("button", { name: "재발급", exact: true }).click();
  await expect(reissue.getByRole("status")).toContainText("처리 여부 확인 중");
  await reissue.getByRole("button", { name: "기록됐는지 확인", exact: true }).click();
  await expect(admin.getByRole("dialog")).toHaveCount(0);
  await expect(admin).not.toHaveURL(original);
  await expect(admin.getByRole("link", { name: "원본 증명서" })).toHaveAttribute("href", original);
  await admin.getByRole("button", { name: "무효화", exact: true }).click();
  const voidSheet = admin.getByRole("dialog", { name: "무효화", exact: true });
  await voidSheet.getByLabel(/^사유/).fill("발급 요청 취소");
  await voidSheet.getByRole("button", { name: "무효화", exact: true }).click();
  await expect(paper).toContainText("무효");
  await expect(admin.getByRole("button", { name: "인쇄", exact: true })).toHaveCount(0);
  await go(admin, "/people/certificates");
  await expect(admin.getByRole("row").filter({ hasText: "HR-" })).toHaveCount(2);
  await expectAccessible(admin, "certificate register");

  const lower = await firstSignIn(browser, await inviteAccount(admin, "권한없는계정", "none"));
  const lowerCall = apiCaller(lower);
  await lower.reload();
  await go(lower, "/people/certificates");
  await expect(lower.getByText("이 범위의 증명서 권한이 없습니다. 권한 관리자에게 요청하십시오.")).toBeVisible();
  const certificateId = page.items[0]!.id;
  for (const [method, path, body] of [
    ["GET", "/api/v1/hr/certificates", undefined],
    ["GET", `/api/v1/hr/certificates/${certificateId}`, undefined],
    ["POST", "/api/v1/hr/certificates", { employee_id: employeeId, kind: "CAREER", items: ["period"], purpose: "제출용" }],
    ["POST", `/api/v1/hr/certificates/${certificateId}/void`, { reason: "시험" }],
    ["POST", `/api/v1/hr/certificates/${certificateId}/reissue`, { reason: "시험" }],
    ["GET", "/api/v1/hr/certificate-settings", undefined],
    ["PUT", "/api/v1/hr/certificate-settings", { legal_entity_id: employeeId, prefix: "OTHER", width: 6, seal_text: "시험", expected_version: 0 }],
  ] as const) {
    const response = await lowerCall(method, path, body);
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe("certificate_forbidden");
  }
  const foreign = await soloTenant(browser, "foreigncertificate", "다른시험");
  const foreignCall = apiCaller(foreign);
  await foreign.reload();
  await go(foreign, "/people/certificates");
  for (const [path, body] of [
    ["/api/v1/hr/certificates", { employee_id: employeeId, kind: "CAREER", items: ["period"], purpose: "제출용" }],
    [`/api/v1/hr/certificates/${certificateId}/void`, { reason: "시험" }],
    [`/api/v1/hr/certificates/${certificateId}/reissue`, { reason: "시험" }],
  ] as const) {
    const response = await foreignCall("POST", path, body);
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  }
  const register = await read<{ items: unknown[] }>("/api/v1/hr/certificates");
  expect(register.items).toHaveLength(2);
});

/** Authenticated refusal probes reuse a session created entirely through the product. */
function apiCaller(page: Page) {
  const bearer = page.waitForRequest(async (request) => request.url().includes("/api/v1/") && Boolean((await request.allHeaders()).authorization))
    .then(async (request) => (await request.allHeaders()).authorization!);
  return async (method: string, path: string, data?: unknown) => page.request.fetch(path, { method, data, headers: { authorization: await bearer, "Idempotency-Key": crypto.randomUUID() } });
}
