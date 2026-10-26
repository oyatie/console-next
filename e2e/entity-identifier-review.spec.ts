// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { FORMATS } from "../apps/web/src/lib/pure/formats";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { grantAccess } from "./access-flows";
import { firstSignIn, go, option, passkeyLogin, registerEmployee, stepUp, takeCode, unique } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { letGrantsAge } from "./second-person-fixture";
import { REGISTRATION_FIXTURES, SETUP_DEPARTMENT, startOperations, tenantInSetup } from "./setup-flows";

const inbox = (page: Page) => page.getByRole("region", { name: "업무함", exact: true });
const register = (page: Page) => page.getByRole("region", { name: "번호 정정 · 사후 검토", exact: true });
const detail = (page: Page) => page.getByRole("dialog", { name: "번호 정정 요청", exact: true });

async function capture(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}-desktop.png`), fullPage: true });
  await atPhoneWidth(page, async () => {
    await page.screenshot({ path: test.info().outputPath(`${name}-390.png`), fullPage: true });
    const dialog = page.getByRole("dialog");
    // A modal makes the record behind it inert; check the visible surface.
    if (await dialog.isVisible()) expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    else await fits(page, name);
  });
}

/** The operating requester submits evidence, completes its passkey ceremony and follows the durable receipt. */
async function requestCorrection(page: Page, value: string, tag: string) {
  await page.getByRole("button", { name: "법인등록번호 식별번호 정정" }).click();
  const sheet = page.getByRole("dialog", { name: "법인등록번호 정정", exact: true });
  await sheet.getByLabel("올바른 번호").fill(value);
  await option(page, "정정 사유", "서류 판독 잘못").click();
  const uploaded = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/entity-documents");
  await sheet.locator('input[type="file"]').setInputFiles({
    name: `등기사항증명서-${tag}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.7\n${tag}\n%%EOF\n`),
  });
  const upload = await uploaded;
  expect(upload.status()).toBe(201);
  const document = await upload.json() as { id: string };
  await expect(sheet.getByText(`등기사항증명서-${tag}.pdf 붙임`)).toBeVisible();
  const pending = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/identifier-corrections") && r.status() === 202);
  await sheet.getByRole("button", { name: "번호 정정", exact: true }).click();
  const receipt = await (await pending).json() as { exception_id: string };
  await expect(sheet).toContainText("번호와 증빙은 그대로입니다");
  await expectAccessible(page, "pending identifier correction");
  await capture(page, `pending-${tag}`);
  await sheet.getByRole("link", { name: "정정 요청 · 사후 검토 확인" }).click();
  await expect(register(page).getByRole("row").filter({ hasText: FORMATS.corpRegNo.display(value) })).toContainText("승인 대기");
  return { id: receipt.exception_id, document: document.id };
}

test("identifier correction: a second person approves, requester applies, and a decline preserves the live evidence", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const slug = "identifier-review";
  const { admin } = await tenantInSetup(browser, slug, "번호검토주식회사", false, "본사", "none");
  await admin.setViewportSize({ width: 1440, height: 900 });
  const recordPath = new URL(admin.url()).pathname;
  const entityId = recordPath.split("/").at(-1)!;
  const bearer = bearerOf(admin);

  // The reviewer is a real employee/account, with its grant and notice made through the product.
  await registerEmployee(admin, { name: "김검토", number: "ID-REVIEW-1", hired: "2024-03-04", unit: SETUP_DEPARTMENT });
  await admin.getByRole("button", { name: "계정 초대" }).click();
  await stepUp(admin.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  const reviewer = await firstSignIn(browser, await takeCode(admin));
  await reviewer.setViewportSize({ width: 1440, height: 900 });
  await go(reviewer, "/");
  await registerEmployee(admin, { name: "이범위", number: "ID-SCOPE-1", hired: "2024-03-04", unit: SETUP_DEPARTMENT });
  await admin.getByRole("button", { name: "계정 초대" }).click();
  await stepUp(admin.getByRole("dialog", { name: "계정 초대" }), "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  const manager = await firstSignIn(browser, await takeCode(admin));
  await startOperations(admin);
  await grantAccess(admin, "김검토", "full");
  await grantAccess(admin, "이범위", "full", /본사/);
  const managerBearer = bearerOf(manager);
  await go(manager, "/", true);
  await passkeyLogin(manager);
  const scopedAuthz = await apiOf(manager, managerBearer)("/me/authz");
  expect(scopedAuthz.status()).toBe(200);
  const scopedCapabilities = await scopedAuthz.json() as { capabilities: { feature: string; org_wide: boolean }[] };
  expect(scopedCapabilities.capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ feature: "org_change_apply", org_wide: false })]));
  expect(scopedCapabilities.capabilities.filter((capability) => ["legal_entity_manage", "org_change_apply"].includes(capability.feature)).every((capability) => !capability.org_wide)).toBe(true);
  await go(manager, "/org/entities");
  await expect(manager.getByRole("heading", { name: "법인·사업장", exact: true })).toBeVisible();
  await expect(register(manager)).toBeHidden();
  await expect(manager.getByText("이 화면에 접근 권한이 없습니다", { exact: true })).toBeHidden();
  const notice = inbox(reviewer).getByRole("listitem").filter({ has: reviewer.getByRole("button", { name: "전체 업무 부여 확인 기록", exact: true }) });
  await expect(notice).toContainText("전체 업무 · 전체 ·", { timeout: 20_000 });
  // The notice arrived live. Reopen the pre-grant stream under its new access scope (period-unlock-approve).
  await reviewer.reload();
  await passkeyLogin(reviewer);
  const confirmed = reviewer.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/notice"));
  await notice.getByRole("button", { name: "전체 업무 부여 확인 기록" }).click();
  expect((await confirmed).status()).toBe(200);
  // The confirmation and its SSE hint can restart an in-flight inbox read.
  await expect(notice).toBeHidden({ timeout: 20_000 });
  letGrantsAge(unique(slug), "김검토");
  let reviewerLoads = 0;
  reviewer.on("request", (request) => { if (request.isNavigationRequest() && request.resourceType() === "document") reviewerLoads++; });

  await go(admin, recordPath);
  const requested = await requestCorrection(admin, REGISTRATION_FIXTURES.second.crn, "approved");
  const api = apiOf(admin, bearer);
  const before = await api(`/legal-entities/${entityId}`);
  expect(before.status()).toBe(200);
  expect((await before.json()).crn.value).toBe(REGISTRATION_FIXTURES.primary.crn);
  const waitingDocument = await api(`/entity-documents/${requested.document}`);
  expect(await waitingDocument.json()).toMatchObject({ legal_entity_id: null, registration_id: null, superseded_at: null });
  await register(admin).getByRole("row").filter({ hasText: FORMATS.corpRegNo.display(REGISTRATION_FIXTURES.second.crn) }).click();
  await expect(detail(admin).getByRole("button", { name: "승인 · 패스키 확인" })).toHaveCount(0);
  await detail(admin).getByRole("button", { name: "돌아가기", exact: true }).click();

  await go(admin, "/");
  await inbox(admin).getByRole("button", { name: /^기다리는 중/ }).click();
  const waiting = inbox(admin).getByRole("listitem").filter({ has: admin.locator(`a[href="/org/entities?correction=${requested.id}#identifier-corrections"]`) });
  await expect(waiting).toContainText("처리 상태: 승인 대기", { timeout: 20_000 });
  await expect(waiting.getByRole("link", { name: "정정 요청 · 사후 검토 확인", exact: true })).toBeVisible();
  await capture(admin, "requester-waiting-home");
  let requesterLoads = 0;
  admin.on("request", (request) => { if (request.isNavigationRequest() && request.resourceType() === "document") requesterLoads++; });

  // The reviewer stays on Home after confirming the grant; the correction arrives through SSE.
  const queue = inbox(reviewer).getByRole("listitem").filter({ has: reviewer.locator(`a[href="/org/entities?correction=${requested.id}#identifier-corrections"]`) });
  await expect(queue).toContainText("번호검토주식회사", { timeout: 20_000 });
  await expect(queue).toContainText("처리 상태: 승인 대기");
  await capture(reviewer, "reviewer-home");
  expect(reviewerLoads, "the reviewer receives the request without reloading Home").toBe(0);
  await queue.getByRole("link", { name: "정정 요청 검토", exact: true }).click();
  await expect(reviewer).toHaveURL(new RegExp(`correction=${requested.id}#identifier-corrections`));
  await expect(detail(reviewer)).toContainText(FORMATS.corpRegNo.display(REGISTRATION_FIXTURES.second.crn));
  await expectAccessible(reviewer, "identifier correction decision");
  await capture(reviewer, "decision");
  const approved = reviewer.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/governed-exceptions/${requested.id}/decide`));
  await detail(reviewer).getByRole("button", { name: "승인 · 패스키 확인", exact: true }).click();
  expect((await approved).status()).toBe(200);
  await expect(detail(reviewer)).toContainText("승인됨 · 적용 대기");
  await detail(reviewer).getByRole("button", { name: "돌아가기", exact: true }).click();

  await expect(waiting).toBeHidden({ timeout: 20_000 });
  await inbox(admin).getByRole("button", { name: /^내 차례/ }).click();
  const apply = inbox(admin).getByRole("listitem").filter({ has: admin.locator(`a[href="/org/entities?correction=${requested.id}#identifier-corrections"]`) });
  await expect(apply).toContainText("처리 상태: 승인됨 · 적용 대기");
  await capture(admin, "requester-approved-home");
  expect(requesterLoads, "the requester receives approval without reloading Home").toBe(0);
  await apply.getByRole("link", { name: "승인된 정정 적용", exact: true }).click();
  await expect(detail(admin).getByRole("button", { name: "승인된 정정 적용", exact: true })).toBeVisible();
  await capture(admin, "apply-approved");
  const ready = register(admin).getByRole("row").filter({ hasText: FORMATS.corpRegNo.display(REGISTRATION_FIXTURES.second.crn) });
  await expect(ready).toContainText("승인됨 · 적용 대기");
  const applied = admin.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/legal-entities/${entityId}/identifier-corrections`);
  await detail(admin).getByRole("button", { name: "승인된 정정 적용", exact: true }).click();
  const appliedResponse = await applied;
  expect(appliedResponse.status()).toBe(200);
  expect((await appliedResponse.json()).change_mode).toBe("GOVERNED");
  await expect(detail(admin)).toBeHidden();
  await go(admin, recordPath);
  await expect(admin.getByText(FORMATS.corpRegNo.display(REGISTRATION_FIXTURES.second.crn), { exact: true }).first()).toBeVisible();
  await admin.getByRole("button", { name: /^이력/ }).click();
  await expect(admin.getByText("운영 중 변경", { exact: true }).first()).toBeVisible();
  const history = await api(`/legal-entities/${entityId}/revisions`);
  expect((await history.json()).items).toEqual(expect.arrayContaining([expect.objectContaining({ change_mode: "GOVERNED" })]));

  // Another proposed certificate is declined: both the applied number and its original stay current.
  await admin.getByRole("button", { name: "개요", exact: true }).click();
  const declined = await requestCorrection(admin, REGISTRATION_FIXTURES.branch_primary.crn, "declined");
  await register(reviewer).getByRole("row").filter({ hasText: FORMATS.corpRegNo.display(REGISTRATION_FIXTURES.branch_primary.crn) }).click();
  await expect(detail(reviewer).getByRole("button", { name: "거절", exact: true })).toHaveAttribute("aria-disabled", "true");
  await detail(reviewer).getByLabel("검토 의견").fill("등기사항증명서와 번호를 다시 대조하십시오");
  await detail(reviewer).getByRole("button", { name: "거절", exact: true }).click();
  await expect(detail(reviewer)).toContainText("거절됨");
  await detail(reviewer).getByRole("button", { name: "돌아가기", exact: true }).click();
  await expect(register(admin).getByRole("row").filter({ hasText: FORMATS.corpRegNo.display(REGISTRATION_FIXTURES.branch_primary.crn) })).toContainText("거절됨");
  const after = await api(`/legal-entities/${entityId}`);
  expect((await after.json()).crn.value).toBe(REGISTRATION_FIXTURES.second.crn);
  const currentDocument = await api(`/entity-documents/${requested.document}`);
  expect(await currentDocument.json()).toMatchObject({ legal_entity_id: entityId, superseded_at: null });
  const declinedDocument = await api(`/entity-documents/${declined.document}`);
  expect(await declinedDocument.json()).toMatchObject({ legal_entity_id: null, registration_id: null, superseded_at: null });
});
