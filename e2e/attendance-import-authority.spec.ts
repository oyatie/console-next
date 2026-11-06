// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { firstSignIn, go } from "./flows";
import { inviteAccount } from "./access-flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";

test("attendance imports require attendance authority before processing input", { tag: ["@hr", "@security"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "attendanceauthority", "근태권한확인");
  const adminBearer = bearerOf(admin);
  await go(admin, "/account");
  await expect.poll(adminBearer).not.toBe("");
  const api = apiOf(admin, adminBearer);
  const before = await (await api("/hr/attendance-import/summary")).json();
  const viewer = await firstSignIn(browser, await inviteAccount(admin, "근태조회계정", "none"));
  const bearer = bearerOf(viewer);
  await viewer.reload();
  await expect.poll(bearer).not.toBe("");
  const denied = await viewer.request.post("/api/v1/hr/attendance-import/preview", {
    headers: { authorization: bearer() },
    multipart: { file: { name: "attendance.txt", mimeType: "text/csv", buffer: Buffer.from("성명,근무일\n직원,2026-06-01\n") } },
  });
  expect([denied.status(), await codeOf(denied)]).toEqual([403, "attendance.refuse.missing_grant"]);
  for (const stage of ["dry-run", "apply"]) {
    const response = await apiOf(viewer, bearer)(`/hr/attendance-import/${crypto.randomUUID()}/${stage}`, "POST", { checklist_all_acknowledged: true });
    expect([response.status(), await codeOf(response)]).toEqual([403, "attendance.refuse.missing_grant"]);
  }
  expect(await (await api("/hr/attendance-import/summary")).json()).toEqual(before);
  await viewer.context().close();
  await admin.context().close();
});
