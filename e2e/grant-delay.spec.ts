// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { grantAccess } from "./access-flows";
import { apiOf, bearerOf } from "./helpers/api";
import { activatePendingGrants } from "./second-person-fixture";
import { tenantInSetup } from "./setup-flows";

test("a sole admin's elevated grant waits for the configured deadline", { tag: ["@access", "@regression"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "grantdelay", "권한대기", false, "본점", "none");
  const token = bearerOf(admin);
  await grantAccess(admin, "이임원", "full", /^전체/, false);
  const api = apiOf(admin, token);
  const read = async () => {
    const response = await api("/access/grants");
    expect(response.ok()).toBeTruthy();
    return await response.json() as { enforcement: string; activates_at?: string | null }[];
  };
  const before = (await read());
  expect(before).toHaveLength(1);
  expect(before[0]!.enforcement).toBe("SCHEDULED");
  expect(Date.parse(before[0]!.activates_at!)).toBeGreaterThan(Date.now());
  await activatePendingGrants(admin, token);
  expect((await read())[0]!.enforcement).toBe("ENFORCED");
});
