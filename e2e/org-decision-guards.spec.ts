// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { firstSignIn, go } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { setupCompany, startOperations } from "./setup-flows";
import { openTenant } from "./helpers/tenant";
import { revealUnit } from "./structure-flows";
import { inviteAccount } from "./access-flows";

test("an org decision refuses missing grants, stale versions, merging, and a cancelled document without changing it", async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "decisionguards", "결재검증회사");
  const bearer = bearerOf(admin);
  await setupCompany(admin, "결재검증회사", "본점");
  await startOperations(admin);
  await go(admin, "/");
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  await go(admin, "/org");
  await revealUnit(admin, "본점");
  await admin.keyboard.press("a");
  const card = admin.getByRole("dialog", { name: "부서 신설", exact: true });
  await expect(card).toBeVisible();
  await card.getByLabel("부서 이름").fill("결재검증부");
  await card.getByRole("button", { name: /^오늘/ }).click();
  await card.getByLabel("사유").fill("결재 거절 검증");
  await card.getByRole("button", { name: "임시 저장" }).click();
  await expect(admin).toHaveURL(/\/org\/changes\/[0-9a-f-]+(?:\?|$)/);
  const id = new URL(admin.url()).pathname.split("/").at(-1)!;
  const read = async () => (await (await api(`/org-changes/${id}`)).json()) as { version: string; status: string };
  const before = await read();
  expect(before.version).toEqual(expect.any(String));
  const decision = `/org-changes/${id}/approval-steps/${crypto.randomUUID()}/decision`;
  for (const [extra, code] of [
    [{ expected_version: "stale" }, "lifecycle.refuse.stale_version"],
    [{ through_step: crypto.randomUUID() }, "lifecycle.refuse.merge_not_allowed"],
  ] as const) {
    const refused = await api(decision, "POST", { decision: "APPROVED", ...extra });
    expect([refused.status(), await codeOf(refused)]).toEqual([409, code]);
    expect(await read()).toEqual(before);
  }
  const viewer = await firstSignIn(browser, await inviteAccount(admin, "결재 권한 없는 사용자", "none"));
  const viewerBearer = bearerOf(viewer);
  await viewer.reload();
  await expect.poll(viewerBearer).not.toBe("");
  const viewerApi = apiOf(viewer, viewerBearer);
  for (const choice of ["APPROVED", "REJECTED"]) {
    const refused = await viewerApi(decision, "POST", { decision: choice });
    expect([refused.status(), await codeOf(refused)]).toEqual([403, "org_change.refuse.missing_grant"]);
    expect(await read()).toEqual(before);
  }
  await viewer.context().close();
  await go(admin, `/org/changes/${id}`);
  await admin.getByRole("button", { name: "초안 취소", exact: true }).click();
  const cancel = admin.getByRole("dialog", { name: "초안 취소", exact: true });
  await cancel.getByLabel("취소 사유").fill("검증 완료");
  await cancel.getByRole("button", { name: /취소$/, exact: false }).last().click();
  await expect.poll(async () => (await read()).status).toBe("CANCELLED");
  const cancelled = await read();
  expect(cancelled.version).not.toBe(before.version);
  const refused = await api(decision, "POST", { decision: "APPROVED", expected_version: before.version });
  expect([refused.status(), await codeOf(refused)]).toEqual([409, "lifecycle.refuse.withdrawn"]);
  expect(await read()).toEqual(cancelled);
});
