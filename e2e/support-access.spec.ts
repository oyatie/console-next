// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash, randomUUID } from "node:crypto";
import createClient from "openapi-fetch";
import { supportSessionsApi, type paths, type components } from "@console/api";
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { firstSignIn, go, registerEmployee, unique, vendorPage, vendorStepUp } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { tenantInSetup } from "./setup-flows";
import { addDepartments } from "./structure-flows";
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
  test.setTimeout(240_000);
  const operator = await vendorPage(browser);
  const requesterBearer = await operatorBearer(operator);
  const fixture = await request.post(`http://127.0.0.1:${PORTS.backend}/__e2e/ops-recovery/operator`, { data: { name: unique("지원 승인 운영자") } });
  expect(fixture.ok()).toBe(true);
  const approver = await firstSignIn(browser, (await fixture.json()).otp);
  const approverBearer = await operatorBearer(approver);
  const { admin: tenant, exec: nonApprover } = await tenantInSetup(browser, "support-access", "지원 승인 고객", false, "지원 본점", "none");
  await go(tenant, "/org");
  await addDepartments(tenant, "지원 본점", ["지원 검토부"]);
  await registerEmployee(tenant, { name: "지원 검토인", unit: "지원 검토부" });
  const tenantBearer = bearerOf(tenant);
  const readerBearer = bearerOf(nonApprover);
  await go(nonApprover, "/account");
  const readerList = nonApprover.waitForResponse((r) => new URL(r.url()).pathname === TENANT_SUPPORT && r.request().method() === "GET");
  await go(nonApprover, "/audit/support-access");
  expect((await readerList).status()).toBe(403);
  await expect(nonApprover.getByRole("navigation").getByRole("link", { name: "지원 접근", exact: true })).toHaveCount(0);
  for (const name of ["지원 접근 승인", "지원 접근 거절", "지원 종료"]) await expect(nonApprover.getByRole("button", { name, exact: true })).toHaveCount(0);
  expect(readerBearer()).not.toBe("");
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
  const tenantWorkplacesResponse = await apiOf(tenant, tenantBearer)("/workplaces");
  expect(tenantWorkplacesResponse.ok()).toBe(true);
  const tenantWorkplaces = await tenantWorkplacesResponse.json() as components["schemas"]["WorkplaceList"];
  const id = randomUUID();
  const body = { id, org_id: org, ticket_ref: unique("HELP"), reason_code: "DIAGNOSE", reason: "조직 조회 오류 확인", scope: ["org", "hr_basic"], duration_seconds: duration };
  const headers = { authorization: requesterBearer() };
  const requester = supportSessionsApi(createClient<paths>({ baseUrl: new URL(operator.url()).origin, headers }));
  const secondOperator = supportSessionsApi(createClient<paths>({ baseUrl: new URL(approver.url()).origin, headers: { authorization: approverBearer() } }));
  await go(tenant, "/");
  const opened = await vendorStepUp(async () => requester.request({
    ...body, step_up: await boundStepUp(operator, requesterBearer(), id, JSON.stringify([org, id, "request", body.ticket_ref, body.reason_code, body.reason, body.scope, duration])),
  }));
  expect(opened.id).toBe(id);
  const approvedByOperator = await secondOperator.approve(id, {
    org_id: org, step_up: await boundStepUp(approver, approverBearer(), id, JSON.stringify([org, id, "approve"])),
  });
  expect(approvedByOperator.state).toBe("OPERATOR_APPROVED");
  // SSE delivers both the notification and Home queue, including the exact pending request and deadline.
  await expect(tenant.getByText("지원 접근 승인 대기 1건", { exact: true }).first()).toBeVisible();
  const queue = tenant.locator("section").filter({ has: tenant.getByRole("heading", { name: "지원 접근 승인 대기 1건", exact: true }) }).last();
  await expect(queue).toContainText(body.ticket_ref);
  await expect(queue).toContainText("승인 대기 만료");
  await expect(queue.getByRole("link", { name: "지원 요청 확인", exact: true })).toHaveAttribute("href", `/audit/support-access?review=${id}`);
  await queue.getByRole("link", { name: "지원 요청 확인", exact: true }).click();
  await expect(tenant.getByText(body.ticket_ref, { exact: true }).first()).toBeVisible();
  for (const suffix of ["decision", "end"]) {
    const denied = await nonApprover.request.post(`${TENANT_SUPPORT}/${id}/${suffix}`, { headers: { authorization: readerBearer() }, data: suffix === "decision" ? { decision: "APPROVE", approved_duration_seconds: duration, reveal_classes: ["personal"] } : {} });
    expect(denied.status()).toBe(403);
    expect(await codeOf(denied)).toBe("forbidden");
  }
  await expect(tenant.getByRole("button", { name: "지원 접근 승인", exact: true })).toBeVisible();
  await expect(tenant.getByRole("checkbox", { name: "이 세션에서 개인정보 열람을 허용합니다" })).not.toBeChecked();
  await expect(tenant.getByRole("spinbutton", { name: "허용할 시간(분)", exact: true })).toHaveValue(String(duration / 60));
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
  const tree = await viewed.json() as components["schemas"]["OrgStructure"];
  expect(tree.tenant_name).toBe("지원 승인 고객");
  expect(tree.phase).toBe("SETUP");
  expect(tree.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(tree.entities[0]?.name).toContain("지원 승인 고객");
  expect((await liveRead).ok()).toBe(true);
  const records = tenant.getByRole("table", { name: "접속기록 · 공급사", exact: true });
  await expect(records.getByText("/api/v1/org-structure", { exact: true })).toBeVisible();
  await expect(records.getByRole("row")).toHaveCount(2);
  expect(documentLoads, "the access record appeared without reloading").toBe(0);
  await auditLayouts(tenant, "active support access records");
  const read = async (path: string) => {
    const response = await operator.request.get(path, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  const units = await read("/api/v1/org-units") as components["schemas"]["OrgUnitList"];
  const unit = units.items.find((u) => u.name === "지원 검토부");
  expect(unit).toMatchObject({ kind: "DEPARTMENT", name: "지원 검토부", status: "ACTIVE", headcount: 1 });
  expect(unit?.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(unit?.updatedAt).not.toBe("••••");
  const entities = await read("/api/v1/legal-entities") as components["schemas"]["LegalEntityList"];
  expect(entities.items[0]?.current?.name).toContain("지원 승인 고객");
  expect(entities.items[0]?.current?.head_office_address?.road_addr_part1).toBeTruthy();
  expect(entities.items[0]?.current?.head_office_address?.road_addr_part1).not.toBe("••••");
  const workplaces = await read("/api/v1/workplaces") as components["schemas"]["WorkplaceList"];
  expect(workplaces.items[0]?.current?.name).toBe("지원 본점");
  expect(workplaces.items[0]?.headcount).toBe(1);
  expect(workplaces.items[0]?.current?.address).toEqual(tenantWorkplaces.items[0]?.current?.address);
  const employees = await read("/api/v1/employees") as components["schemas"]["EmployeePage"];
  expect(employees.total).toBe(1);
  expect(employees.items[0]?.name).toBe("••••");
  expect(JSON.stringify(employees)).not.toContain("지원 검토인");
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
