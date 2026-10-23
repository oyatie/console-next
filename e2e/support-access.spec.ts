// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash, randomUUID } from "node:crypto";
import createClient from "openapi-fetch";
import { supportSessionsApi, type paths, type components } from "@console/api";
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { firstSignIn, go, unique, vendorPage, vendorStepUp } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { PORTS } from "./slot";

const TENANT_SUPPORT = "/api/v1/support-sessions";

/** Real WebAuthn assertion bound to the published support-session payload. */
async function boundStepUp(page: Page, authorization: string, id: string, payload: string): Promise<components["schemas"]["MobilePasskeyStepUpEnvelope"]> {
  const binding: components["schemas"]["MobilePasskeyStepUpBinding"] = {
    action_kind: "SUPPORT_SESSION", object_id: id, reason_key: "passkey_step_up_support_session", replay_attempt: null,
    payload_hash: createHash("sha256").update(payload).digest("hex"),
  };
  const response = await page.request.post("/api/v1/auth/passkey/step-up/start", { headers: { authorization }, data: { binding } });
  expect(response.status(), "bound support step-up starts").toBe(200);
  const ceremony = await response.json() as { ceremony_id: string; challenge: { publicKey: PublicKeyCredentialRequestOptionsJSON } };
  const credential = await page.evaluate(async (options) => {
    const assertion = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) }) as PublicKeyCredential | null;
    return assertion?.toJSON();
  }, ceremony.challenge.publicKey);
  expect(credential).toBeTruthy();
  return { binding, assertion: { ceremony_id: ceremony.ceremony_id, credential: credential as Record<string, unknown> } };
}

/** Capture the operator's existing bearer through its own passkey read. */
async function operatorBearer(page: Page) {
  const bearer = bearerOf(page);
  await go(page, "/account");
  const passkeys = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/passkeys" && r.request().method() === "GET");
  await page.reload();
  expect((await passkeys).ok()).toBe(true);
  expect(bearer()).not.toBe("");
  return bearer;
}

async function auditLayouts(page: Page, context: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectAccessible(page, `${context} at 1440px`);
  await atPhoneWidth(page, async () => {
    await expectAccessible(page, `${context} at 390px`);
    await fits(page, context);
  });
}

test("two operators and the customer authorize support; every read arrives live and termination revokes the token", { tag: ["@auth", "@live"] }, async ({ browser, browserName, request }) => {
  test.skip(browserName !== "chromium", "The support ceremony and live-flow acceptance is exercised in Chromium.");
  test.setTimeout(180_000);
  const operator = await vendorPage(browser);
  const requesterBearer = await operatorBearer(operator);
  const fixture = await request.post(`http://127.0.0.1:${PORTS.backend}/__e2e/ops-recovery/operator`, { data: { name: unique("지원 승인 운영자") } });
  expect(fixture.ok()).toBe(true);
  const approver = await firstSignIn(browser, (await fixture.json()).otp);
  const approverBearer = await operatorBearer(approver);
  const tenant = await openTenant(browser, "support-access", "지원 승인 고객");
  const tenantBearer = bearerOf(tenant);
  const initialList = tenant.waitForResponse((r) => new URL(r.url()).pathname === TENANT_SUPPORT && r.request().method() === "GET");
  await go(tenant, "/audit/support-access");
  expect((await (await initialList).json()).can_approve, "the first tenant ops account can approve through the access catalog").toBe(true);
  const org = (JSON.parse(Buffer.from(tenantBearer().replace(/^Bearer /, "").split(".")[1]!, "base64url").toString("utf8")) as { org: string }).org;
  const settingsResponse = await apiOf(tenant, tenantBearer)("/settings");
  expect(settingsResponse.ok()).toBe(true);
  const settings = await settingsResponse.json() as { items: { key: string; value: unknown }[] };
  const durationHours = settings.items.find((s) => s.key === "support.max_duration")?.value;
  expect(typeof durationHours).toBe("number");
  const duration = Number(durationHours) * 60 * 60;
  expect(duration).toBeGreaterThan(0);
  const id = randomUUID();
  const body = { id, org_id: org, ticket_ref: unique("HELP"), reason_code: "DIAGNOSE", reason: "조직 조회 오류 확인", scope: ["org"], duration_seconds: duration };
  const headers = { authorization: requesterBearer() };
  const requester = supportSessionsApi(createClient<paths>({ baseUrl: new URL(operator.url()).origin, headers }));
  const secondOperator = supportSessionsApi(createClient<paths>({ baseUrl: new URL(approver.url()).origin, headers: { authorization: approverBearer() } }));
  const opened = await vendorStepUp(async () => requester.request({
    ...body, step_up: await boundStepUp(operator, requesterBearer(), id, JSON.stringify([org, id, "request", body.ticket_ref, body.reason_code, body.reason, body.scope, duration])),
  }));
  expect(opened.id).toBe(id);
  const approvedByOperator = await secondOperator.approve(id, {
    org_id: org, step_up: await boundStepUp(approver, approverBearer(), id, JSON.stringify([org, id, "approve"])),
  });
  expect(approvedByOperator.state).toBe("OPERATOR_APPROVED");
  // The open tenant screen receives both transitions through SSE; there is no navigation or manual refresh.
  await expect(tenant.getByText(body.ticket_ref, { exact: true }).first()).toBeVisible();
  await expect(tenant.getByRole("button", { name: "지원 접근 승인", exact: true })).toBeVisible();
  await expect(tenant.getByRole("checkbox", { name: "이 세션에서 개인정보 열람을 허용합니다" })).not.toBeChecked();
  await auditLayouts(tenant, "support approval");
  const decision = tenant.waitForResponse((r) => new URL(r.url()).pathname === `${TENANT_SUPPORT}/${id}/decision` && r.request().method() === "POST");
  await tenant.getByRole("button", { name: "지원 접근 승인", exact: true }).click();
  expect((await decision).ok()).toBe(true);
  await expect(tenant.getByRole("table", { name: "요청·승인·종료 기록", exact: true }).getByText("고객 승인", { exact: true })).toBeVisible();
  const started = await vendorStepUp(async () => requester.start(id, {
    org_id: org, step_up: await boundStepUp(operator, requesterBearer(), id, JSON.stringify([org, id, "start"])),
  }));
  const token = started.access_token;
  const metadata = (await requester.list(org)).sessions.find((s) => s.id === id);
  expect(metadata?.state).toBe("ACTIVE");
  expect(metadata).not.toHaveProperty("reason");
  await expect(tenant.getByText("공급사 지원 접근이 진행 중입니다", { exact: true })).toBeVisible();
  await expect(tenant.getByRole("button", { name: "지원 종료", exact: true })).toBeVisible();
  let documentLoads = 0;
  tenant.on("load", () => { documentLoads++; });
  const liveRead = tenant.waitForResponse((r) => new URL(r.url()).pathname === TENANT_SUPPORT && r.request().method() === "GET");
  const viewed = await operator.request.get("/api/v1/org-structure", { headers: { authorization: `Bearer ${token}` } });
  expect(viewed.status(), await viewed.text()).toBe(200);
  expect((await liveRead).ok()).toBe(true);
  const records = tenant.getByRole("table", { name: "접속기록 · 공급사", exact: true });
  await expect(records.getByText("/api/v1/org-structure", { exact: true })).toBeVisible();
  await expect(records.getByRole("row")).toHaveCount(2);
  expect(documentLoads, "the access record appeared without reloading").toBe(0);
  await auditLayouts(tenant, "active support access records");
  await go(tenant, "/account");
  await expect(tenant.getByText("공급사 지원 접근이 진행 중입니다", { exact: true })).toBeVisible();
  await tenant.getByRole("link", { name: "지원 기록 확인 · 종료", exact: true }).click();
  const ended = tenant.waitForResponse((r) => new URL(r.url()).pathname === `${TENANT_SUPPORT}/${id}/end` && r.request().method() === "POST");
  await tenant.getByRole("button", { name: "지원 종료", exact: true }).click();
  expect((await ended).ok()).toBe(true);
  await expect(tenant.getByText("공급사 지원 접근이 진행 중입니다", { exact: true })).toBeHidden();
  const refused = await operator.request.get("/api/v1/org-structure", { headers: { authorization: `Bearer ${token}` } });
  expect(refused.status()).toBe(401);
  expect(await codeOf(refused)).toBe("support.refuse.session_ended");
  expect(await requester.end(id, org)).toEqual({ ended: true });
});

test("a tenant opening the vendor route receives the Korean 404 page", { tag: ["@auth", "@negative"] }, async ({ browser }) => {
  const tenant = await openTenant(browser, "support-404", "지원 경계 고객");
  for (const path of ["/platform", "/platform/support-sessions"]) {
    await go(tenant, path);
    await expect(tenant.getByRole("heading", { name: "페이지를 찾을 수 없습니다", exact: true })).toBeVisible();
    expect(new URL(tenant.url()).pathname).toBe(path);
  }
});
