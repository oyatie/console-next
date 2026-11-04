// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { go } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { tenantBeforeSetup } from "./setup-flows";

test("approval list serves authorized empty boxes and refuses invalid cursors", { tag: ["@hr", "@live"] }, async ({ browser }) => {
  test.setTimeout(180_000);
  const { admin } = await tenantBeforeSetup(browser, "approvalread", "결재 조회", false, "none");
  const bearer = bearerOf(admin);
  await go(admin, "/org");
  await admin.reload();
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  for (const box of ["pending", "upcoming", "requested", "reference", "completed"]) {
    const response = await api(`/approvals?box=${box}&focus=org_change:00000000-0000-0000-0000-000000000001`);
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toEqual({
      items: [], focused: null, sources: [], next_cursor: null,
      counts: { pending: 0, upcoming: 0, requested: 0, reference: 0, completed: 0 },
    });
  }
  const invalid = await api("/approvals?box=pending&cursor=invalid");
  expect(invalid.status()).toBe(422);
});
