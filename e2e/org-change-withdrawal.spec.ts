// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { go } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { setupCompany, startOperations } from "./setup-flows";
import { revealUnit } from "./structure-flows";

test("a drafter withdraws a routed change after go-live and keeps its chain on record", async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "withdrawchange", "상신회수회사");
  const bearer = bearerOf(admin);
  await setupCompany(admin, "상신회수회사", "본점");
  await startOperations(admin);
  await go(admin, "/");
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  // The settings editor is outside this backend slice; use its real command, as in settings-cedar.
  const routed = await api("/settings/approval.policy.org_structure", "POST", { value: "route", reason_code: "POLICY_REVIEW" });
  expect(routed.status()).toBe(201);
  await admin.reload();
  await go(admin, "/org");
  await revealUnit(admin, "본점");
  await admin.keyboard.press("a");
  const card = admin.getByRole("dialog", { name: "부서 신설", exact: true });
  await card.getByLabel("부서 이름").fill("회수검증부");
  await card.getByRole("button", { name: /^오늘/ }).click();
  await card.getByLabel("사유").fill("회수 검증을 위한 상신");
  const submitted = admin.waitForResponse((r) => r.request().method() === "POST" && /\/org-changes\/[^/]+\/submit$/.test(new URL(r.url()).pathname));
  await expect(card.getByRole("button", { name: /결재 요청$/ })).toBeVisible();
  await card.getByRole("button", { name: /결재 요청$/ }).click();
  const before = await (await submitted).json() as components["schemas"]["OrgChangeDetail"];
  expect(before.status).toBe("IN_APPROVAL");
  expect(before.version).toEqual(expect.any(String));
  expect(before.approvalSteps).not.toHaveLength(0);
  const draft = await api("/org-changes", "POST", {
    kind: before.kind, target: before.target, effectiveDate: before.effectiveDate,
    reason: "초안 취소 검증", proposal: before.proposal,
  }, { "Idempotency-Key": crypto.randomUUID() });
  expect(draft.status(), await draft.text()).toBe(201);
  const draftPath = `/org-changes/${(await draft.json()).id as string}`;
  const edited = await api(draftPath, "PATCH", { reason: "수정한 초안 취소" });
  expect(edited.status()).toBe(200);
  const draftCancelled = await api(`${draftPath}/cancel`, "POST", { reason: "초안 취소" });
  expect(draftCancelled.status()).toBe(200);
  expect((await draftCancelled.json()).status).toBe("CANCELLED");
  const read = async () => (await (await api(`/org-changes/${before.id}`)).json()) as typeof before;
  // Withdrawal's screen control is handed to the web lane; exercise the real command here.
  const cancelled = await api(`/org-changes/${before.id}/cancel`, "POST", { reason: "결재자 추가 후 다시 상신" });
  expect(cancelled.status()).toBe(200);
  const after = await read();
  expect(after.status).toBe("CANCELLED");
  expect(after.approvalSteps).toEqual(before.approvalSteps);
  expect(after.version).not.toBe(before.version);
  const refused = await api(`/org-changes/${before.id}/approval-steps/${crypto.randomUUID()}/decision`, "POST", { decision: "APPROVED", expected_version: before.version });
  expect([refused.status(), await codeOf(refused)]).toEqual([409, "lifecycle.refuse.withdrawn"]);
  const body = await refused.json();
  expect(body.error).toMatchObject({ code: "lifecycle.refuse.withdrawn", message: expect.any(String) });
  expect(await read()).toEqual(after);
  await go(admin, `/org/changes/${before.id}`);
  await expect(admin.getByText("결재자 추가 후 다시 상신", { exact: true }).first()).toBeVisible();
});
