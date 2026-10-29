// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { grantAccess } from "./access-flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { tenantInSetup } from "./setup-flows";

test("payroll run reads require pay access even with other tenant grants", { tag: ["@hr", "@negative", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin, exec: reader } = await tenantInSetup(browser, "payroll-run-access", "급여권한검토상사", false, "본점", "none");
  const token = bearerOf(reader);
  const opsToken = bearerOf(admin);
  await reader.reload();
  await expect.poll(token).toMatch(/^Bearer /);
  const api = apiOf(reader, token);
  const missing = `/payroll/runs/${randomUUID()}`;
  try {
    for (const path of ["/payroll/runs", missing]) {
      const refused = await api(path);
      expect(refused.status()).toBe(403);
      expect(await codeOf(refused)).toBe("forbidden");
    }
    await grantAccess(admin, "이임원", "full");
    // The released role editor offers no pay line yet; other domain grants cannot open payroll.
    const unrelated = await api("/payroll/runs");
    expect(unrelated.status()).toBe(403);
    expect(await codeOf(unrelated)).toBe("forbidden");
    const opsApi = apiOf(admin, opsToken);
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
