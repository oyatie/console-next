// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { firstSignIn, go, kstDate } from "./flows";
import { inviteAccount } from "./access-flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { setupCompany, startOperations } from "./setup-flows";

test("draft refusals distinguish invalid input and missing authority without creating records", async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "draftadmission", "기안검증회사");
  const bearer = bearerOf(admin);
  await setupCompany(admin, "기안검증회사", "본점");
  await startOperations(admin);
  await go(admin, "/");
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  const list = async () => (await api("/org-changes")).json();
  const before = await list();
  const draft = {
    kind: "NEW", target: { kind: "ORG_UNIT", ref: "not-a-uuid", label: "부서" },
    effectiveDate: kstDate(), reason: "기안 거절 검증",
    proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: crypto.randomUUID(), name: "기안검증부" }],
  } satisfies components["schemas"]["CreateOrgChangeRequest"];
  const invalid = await api("/org-changes", "POST", draft, { "Idempotency-Key": crypto.randomUUID() });
  expect([invalid.status(), await codeOf(invalid)]).toEqual([422, "validation"]);
  expect((await invalid.json()).error.support_ref).toEqual(expect.any(String));
  expect(await list()).toEqual(before);
  const viewer = await firstSignIn(browser, await inviteAccount(admin, "기안 권한 없는 사용자", "none"));
  const viewerBearer = bearerOf(viewer);
  await viewer.reload();
  await expect.poll(viewerBearer).not.toBe("");
  const viewerApi = apiOf(viewer, viewerBearer);
  for (const [path, body] of [
    ["/org-changes", { ...draft, target: { ...draft.target, ref: crypto.randomUUID() } }],
    ["/org-units", { kind: "DEPARTMENT", parentId: crypto.randomUUID(), name: "기안검증부" }],
    ["/regions", { name: "권한 없는 지역" }],
    ["/branches", { name: "권한 없는 지점", region_id: crypto.randomUUID() }],
    ["/regions", { name: "가".repeat(121) }],
    ["/branches", { name: "가".repeat(121), region_id: crypto.randomUUID() }],
  ] as const) {
    const denied = await viewerApi(path, "POST", body, { "Idempotency-Key": crypto.randomUUID() });
    expect([denied.status(), await codeOf(denied)]).toEqual([403, "org_change.refuse.missing_grant"]);
    expect((await denied.json()).error.support_ref).toEqual(expect.any(String));
    expect(await list()).toEqual(before);
  }
  await viewer.context().close();
});
