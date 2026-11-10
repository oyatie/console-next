// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { expect, type Browser } from "@playwright/test";
import { readDevSecrets } from "../../scripts/dev-secrets";
import { PORTS } from "../slot";
import type { components } from "@console/api";
import { go, registerEmployee, routeReady } from "../flows";
import { atPhoneWidth, expectAxe, fits } from "../a11y";
import { SETUP_DEPARTMENT, setupCompany, startOperations } from "../setup-flows";
import { revealUnit } from "../structure-flows";
import { apiOf, bearerOf } from "./api";
import { openTenant } from "./tenant";

type Detail = components["schemas"]["OrgChangeDetail"];

export async function soleHolderJourney(browser: Browser) {
  const admin = await openTenant(browser, "soloroute", "단독결재회사");
  const token = bearerOf(admin);
  await setupCompany(admin, "단독결재회사", "본점");
  await registerEmployee(admin, { name: "운영 담당자", unit: SETUP_DEPARTMENT });
  const employee = new URL(admin.url()).pathname.split("/").pop()!;
  await expect.poll(token).not.toBe("");
  const claims = JSON.parse(Buffer.from(token().split(".")[1]!, "base64url").toString()) as { sub: string; org: string };
  // shortcut: self-binding is deliberately forbidden; replace this identity precondition when governed bootstrap binding is available.
  const linked = execFileSync("psql", ["-X", "-q", "-A", "-t", "--set", "ON_ERROR_STOP=1",
    "--set", `org=${claims.org}`, "--set", `actor=${claims.sub}`, "--set", `employee=${employee}`, "--dbname", "console_dev"], {
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(PORTS.pg), PGUSER: "console_app", PGPASSWORD: readDevSecrets().postgresAppPassword },
    input: `BEGIN;
SELECT set_config('app.current_org', :'org', true);
UPDATE users u SET employee_id=e.id, person_id=b.person_id
FROM employees e JOIN employee_person_bindings b ON b.org_id=e.org_id AND b.employee_id=e.id
WHERE u.org_id=current_setting('app.current_org')::uuid AND u.id=:'actor'::uuid
  AND u.is_tenant_ops AND u.employee_id IS NULL AND e.org_id=u.org_id AND e.id=:'employee'::uuid
RETURNING u.id;
COMMIT;`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  expect(linked.trim().split("\n").at(-1)).toBe(claims.sub);
  const api = apiOf(admin, token);
  let sent: { body: components["schemas"]["OrgChangeDecisionRequest"]; key: string } | undefined;
  // Observe the envelope before streamed request bodies are released; every command reaches the real backend.
  await admin.route(url => /\/org-changes\/[^/]+\/approval-steps\/[^/]+\/decision$/.test(url.pathname), async route => {
    sent = { body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"]! };
    await route.continue();
  });
  await startOperations(admin);
  const policy = await api("/settings/approval.policy.org_structure", "POST", { value: "route", reason_code: "POLICY_REVIEW" });
  expect(policy.status(), await policy.text()).toBe(201);
  const settings = await (await api("/settings")).json();
  const review = settings.items.find((s: { key: string }) => s.key === "review.sole_holder_exception.due");
  // Change a consent fact after the offer; the signed old offer must refresh rather than log the user out.
  const reviewDays = review.value > 1 ? review.value - 1 : review.value + 1;
  await admin.reload();
  await go(admin, "/org");
  await revealUnit(admin, "본점");
  await expect.poll(() => new URL(admin.url()).searchParams.get("sel")).toBeTruthy();
  await go(admin, `/org?sel=${new URL(admin.url()).searchParams.get("sel")}&act=dept-add`);
  const composer = admin.getByRole("dialog", { name: "부서 신설", exact: true });
  await composer.getByLabel("부서 이름").fill("단독승인부");
  await composer.getByRole("button", { name: /^오늘/ }).click();
  await composer.getByLabel("사유").fill("운영 조직 확장");
  const submitted = admin.waitForResponse(r => r.request().method() === "POST" && /\/org-changes\/[^/]+\/submit$/.test(new URL(r.url()).pathname));
  await composer.getByRole("button", { name: /결재 요청$/ }).click();
  let detail: Detail = await (await submitted).json();
  expect(detail.status).toBe("IN_APPROVAL");
  expect(detail.approvalSteps).toHaveLength(4);
  await expect(composer).toHaveCount(0);
  await routeReady(admin);
  await go(admin, `/org/changes/${detail.id}`);
  const read = async (): Promise<Detail> => {
    const response = await api(`/org-changes/${detail.id}`);
    expect(response.status()).toBe(200);
    return response.json();
  };
  detail = await read();
  expect(detail.sole_holder_decision).not.toBeNull();
  const steps = detail.approvalSteps.map(s => s.id);
  const ceremonies = new Set<string>();
  const exceptions = new Set<string>();
  const hashes = new Set<string>();
  const open = admin.getByRole("button", { name: "단독 예외 처리", exact: true });
  await open.click();
  const dialog = admin.getByRole("dialog", { name: "단독 예외 처리", exact: true });
  const commit = dialog.getByRole("button", { name: "패스키로 확인하고 조직 변경 승인", exact: true });
  const changed = await api("/settings/review.sole_holder_exception.due", "POST", { value: reviewDays, reason_code: "POLICY_REVIEW" });
  expect(changed.status(), await changed.text()).toBe(201);
  const stale = admin.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/approval-steps/${steps[0]}/decision`));
  const refreshed = admin.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === `/api/v1/org-changes/${detail.id}`);
  await commit.click();
  const refused = await stale;
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("lifecycle.refuse.stale_version");
  detail = await (await refreshed).json();
  expect(detail.sole_holder_exception).toBeNull();
  expect(detail.approvalSteps.every(s => s.decision === "PENDING")).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("결재 내용이 바뀌어 승인하지 않았습니다. 바뀐 내용을 확인하고 다시 승인하십시오.");
  await expect(dialog).toContainText(detail.sole_holder_decision!.payload_hash.slice(0, 12));
  await expect(admin).toHaveURL(new RegExp(`/org/changes/${detail.id}$`));

  for (const [index, step] of steps.entries()) {
    const offer = detail.sole_holder_decision!;
    expect(offer.step_id).toBe(step);
    hashes.add(offer.payload_hash);
    if (index > 0) {
      await admin.getByRole("button", { name: "다음 결재 단계 열기", exact: true }).click();
      await open.click();
    }
    if (index === 0) await atPhoneWidth(admin, async () => {
      for (const theme of ["light", "dark"]) {
        await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await fits(admin, `sole-holder ${theme}`);
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await expectAxe(admin, "sole-holder consent");
    });
    const decided = admin.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/approval-steps/${step}/decision`));
    await commit.click();
    const response = await decided;
    expect(response.status(), await response.text()).toBe(200);
    const body = sent!.body;
    expect(body).toMatchObject({ decision: "APPROVED", expected_version: offer.expected_version,
      step_up: { binding: { action_kind: "EXCEPTION_DECIDE", object_id: detail.id,
        reason_key: "passkey_step_up_exception_decide", replay_attempt: null, payload_hash: offer.payload_hash } } });
    expect(body).not.toHaveProperty("through_step");
    ceremonies.add(body.step_up!.assertion.ceremony_id);
    detail = await response.json();
    expect(detail.status).toBe(index === steps.length - 1 ? "APPROVED" : "IN_APPROVAL");
    expect(detail.approvalSteps.filter(s => s.decision === "APPROVED")).toHaveLength(index + 1);
    const receipt = detail.sole_holder_exception!;
    expect(receipt.id).toBeTruthy();
    expect(receipt.notice_count).toBe(offer.notice_count);
    expect(receipt.notice_count).toBeGreaterThan(0);
    expect(Math.abs(Date.parse(receipt.review_due_at) - Date.parse(response.headers().date!) - reviewDays * 86_400_000)).toBeLessThan(30_000);
    exceptions.add(receipt.id);
    await expect(dialog).toHaveCount(0);
    await expect(admin.getByText("단독 예외로 승인했습니다", { exact: false }).first()).toBeVisible();
    await expect(open).toHaveCount(0);
    expect((await read()).sole_holder_exception).toEqual(receipt);
    // Replaying the same command must retain the same receipt and next step, without another exception/notice.
    const replay = await api(`/org-changes/${detail.id}/approval-steps/${step}/decision`, "POST", body,
      { "Idempotency-Key": sent!.key });
    expect(replay.status(), await replay.text()).toBe(409);
    expect((await replay.json()).error.code).toBe("command_applied");
    const replayed = await read();
    expect(replayed.sole_holder_exception).toEqual(receipt);
    expect(replayed.approvalSteps).toEqual(detail.approvalSteps);
  }
  expect(ceremonies.size).toBe(steps.length);
  expect(hashes.size).toBe(steps.length);
  expect(exceptions.size).toBe(steps.length);
  await admin.reload();
  await routeReady(admin);
  expect((await read()).sole_holder_exception).toEqual(detail.sole_holder_exception);
  expect((await read()).sole_holder_decision).toBeNull();
  await expect(open).toHaveCount(0);
  await expect(admin.getByText(`알림 기록 ${detail.sole_holder_exception!.notice_count}건`, { exact: false })).toBeVisible();
  await atPhoneWidth(admin, async () => { await fits(admin, "sole-holder receipt"); await expectAxe(admin, "sole-holder receipt"); });
}
