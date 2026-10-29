// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { tenantInSetup } from "./setup-flows";

test("payroll reads and commands require tenant pay access", { tag: ["@hr", "@negative", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin, exec: reader } = await tenantInSetup(browser, "payroll-run-access", "급여권한검토상사", false, "본점", "none");
  const token = bearerOf(reader);
  const opsToken = bearerOf(admin);
  await Promise.all([reader.reload(), admin.reload()]);
  await expect.poll(token).toMatch(/^Bearer /);
  await expect.poll(opsToken).toMatch(/^Bearer /);
  const api = apiOf(reader, token);
  const missing = `/payroll/runs/${randomUUID()}`;
  try {
    const readiness = await api("/payroll/payslips/me");
    expect(readiness.status()).toBe(200);
    const page = await readiness.json();
    expect(page).toMatchObject({ items: [], total: 0 });
    expect(JSON.stringify(page)).not.toMatch(/won/i);
    for (const path of ["/payroll/runs", missing, `${missing}/close-preflight`, `${missing}/exceptions`, `${missing}/payslip-delivery`]) {
      const refused = await api(path);
      expect(refused.status()).toBe(403);
      expect(await codeOf(refused)).toBe("forbidden");
    }
    const commands: [string, object | undefined][] = [
      ["close-attendance", { attest: true }], ["calculate", undefined],
      [`exceptions/${randomUUID()}/resolve`, { action: "ACKNOWLEDGE" }],
      ["submit", undefined], ["decision", { decision: "APPROVE" }], ["withdraw", undefined],
      ["schedule-disbursement", { scheduled_at: new Date(Date.now() + 86_400_000).toISOString() }],
      ["disbursement/attest", { status: "SUCCEEDED" }], ["issue-payslips", undefined],
    ];
    const inboxBefore = await api("/me/inbox-docs?filter=payslip");
    expect(inboxBefore.status()).toBe(200);
    const before = await inboxBefore.json();
    for (const [suffix, body] of commands) {
      const refused = await api(`${missing}/${suffix}`, "POST", body);
      expect(refused.status()).toBe(403);
      expect(await codeOf(refused)).toBe("forbidden");
    }
    const inboxAfter = await api("/me/inbox-docs?filter=payslip");
    expect(inboxAfter.status()).toBe(200);
    expect(await inboxAfter.json()).toEqual(before);
    // The bootstrap owner holds tenant pay access; payroll is not offered in the MVP role grid.
    const opsApi = apiOf(admin, opsToken);
    expect((await opsApi("/payroll/runs")).status()).toBe(200);
    for (const suffix of ["close-preflight", "exceptions", "payslip-delivery"]) {
      expect((await opsApi(`${missing}/${suffix}`)).status()).toBe(404);
    }
    for (const [suffix, body] of commands) {
      expect((await opsApi(`${missing}/${suffix}`, "POST", body)).status()).toBe(404);
    }
    const listed = await opsApi("/payroll/runs");
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [], total: 0 });
    const absent = await opsApi(missing);
    expect(absent.status()).toBe(404);
    expect(await codeOf(absent)).toBe("not_found");
  } finally {
    await Promise.all([admin.context().close(), reader.context().close()]);
  }
});
