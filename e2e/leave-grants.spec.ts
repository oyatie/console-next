// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { ko } from "../packages/i18n/src/catalogs/ko";
import { bootKo } from "../packages/i18n/src/catalogs/boot";
import { grantAccess } from "./access-flows";
import { firstSignIn, go, kstDate, registerEmployee, stepUp, takeCode, unique } from "./flows";
import { bearerOf } from "./helpers/api";
import { psql } from "./idle-fixture";
import { SETUP_DEPARTMENT, tenantInSetup } from "./setup-flows";

for (const scope of ["workplace", "department"] as const) {
test(`a tenant-granted employee approves leave within their ${scope}`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(600_000);
  const slug = `leavegrant${scope}`;
  const { admin } = await tenantInSetup(browser, slug, "Leave Example", false, "Leave Workplace", "none");
  const adminBearer = bearerOf(admin);
  const people = [];
  for (const [name, number] of [["Leave Requester", "LG-101"], ["Leave Approver", "LG-102"]]) {
    await registerEmployee(admin, { name: name!, number: number!, unit: SETUP_DEPARTMENT, hired: kstDate(-60) });
    await admin.getByRole("button", { name: ko["accounts.invite"], exact: true }).click();
    await stepUp(admin.getByRole("dialog", { name: ko["accounts.invite"] }), ko["accounts.invite.commit"], admin.getByLabel(bootKo["common.oneTimeCode"]));
    people.push(await firstSignIn(browser, await takeCode(admin)));
  }
  const [requester, approver] = people;
  const requesterBearer = bearerOf(requester!);
  const approverBearer = bearerOf(approver!);
  await go(requester!, "/account");
  await go(approver!, "/account");
  await expect.poll(requesterBearer).not.toBe("");
  await expect.poll(approverBearer).not.toBe("");
  const date = kstDate(7);
  // Leave has no browser form yet; exercise its real transport after product-created accounts and grants.
  const created = await requester!.request.post("/api/v2/leave/requests", {
    headers: { authorization: requesterBearer() },
    data: { leave_type: "annual", idempotency_key: crypto.randomUUID(), start_date: date, end_date: date },
  });
  expect(created.status(), await created.text()).toBe(201);
  const leave = await created.json() as { id: string; request_version: number; subject_employee_id: string };
  // Entitlement import has no leave form; seed only the balance, keeping accounts and authority product-created.
  psql(unique(slug), `SET LOCAL ROLE console_leave_definer;
    UPDATE employees SET leave_accrued=1,leave_used=0,leave_remaining=1
    WHERE org_id=current_setting('app.current_org')::uuid AND id='${leave.subject_employee_id}'::uuid;`);
  const path = `/api/v2/leave/requests/${leave.id}`;
  const decision = { decision: "approve", expected_version: leave.request_version };
  const refused = await approver!.request.post(`${path}/decide`, { headers: { authorization: approverBearer() }, data: decision });
  expect(refused.status(), await refused.text()).toBe(403);
  const stale = await approver!.request.post(`${path}/decide`, {
    headers: { authorization: approverBearer() }, data: { ...decision, expected_version: leave.request_version + 1 },
  });
  expect(stale.status(), await stale.text()).toBe(403);
  const unchanged = await requester!.request.get("/api/v2/me/leave", { headers: { authorization: requesterBearer() } });
  expect(unchanged.status(), await unchanged.text()).toBe(200);
  expect((await unchanged.json()).requests.items).toContainEqual(expect.objectContaining({ id: leave.id, status: "pending", request_version: leave.request_version }));
  await grantAccess(admin, "Leave Approver", "full", scope === "department" ? new RegExp(SETUP_DEPARTMENT) : /Leave Workplace/);
  await go(approver!, "/account");
  const queue = await approver!.request.get("/api/v2/leave/requests", { headers: { authorization: approverBearer() } });
  expect(queue.status(), await queue.text()).toBe(200);
  expect((await queue.json()).items).toContainEqual(expect.objectContaining({ id: leave.id }));
  const resolution = {
    expected_version: leave.request_version,
    date_charges: [{ date, obligation: { kind: "scheduled", minutes: 480 }, charge_units: "1" }],
    calendar_revision_ref: { kind: "manual", reference: "Work calendar", revision: "1" },
    policy_revision_ref: { kind: "manual", reference: "Leave policy", revision: "1" },
  };
  const resolved = await admin.request.post(`${path}/charge-resolution`, { headers: { authorization: adminBearer() }, data: resolution });
  expect(resolved.status(), await resolved.text()).toBe(200);
  const version = (await resolved.json() as { request_version: number }).request_version;
  const approved = await approver!.request.post(`${path}/decide`, {
    headers: { authorization: approverBearer() }, data: { decision: "approve", expected_version: version },
  });
  expect(approved.status(), await approved.text()).toBe(200);
  expect((await approved.json()).status).toBe("approved");
  await requester!.context().close();
  await approver!.context().close();
});
}
