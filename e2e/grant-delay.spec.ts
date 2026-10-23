// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { grantAccess } from "./access-flows";
import { apiOf, bearerOf } from "./helpers/api";
import { activatePendingGrants } from "./second-person-fixture";
import { startOperations, tenantInSetup } from "./setup-flows";

test("a sole admin's elevated grant waits for the configured deadline", { tag: ["@access", "@regression"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "grantdelay", "권한대기", false, "본점", "none");
  await startOperations(admin);
  const token = bearerOf(admin);
  const previewResponse = admin.waitForResponse((r) => r.url().endsWith("/access/grants/preview") && r.request().method() === "POST");
  await grantAccess(admin, "이임원", "full", /^전체/, false);
  const preview = await (await previewResponse).json() as { items: { enforcement_after: string; activates_at?: string }[] };
  expect(preview.items[0]!.enforcement_after).toBe("SCHEDULED");
  expect(Date.parse(preview.items[0]!.activates_at!)).toBeGreaterThan(Date.now());
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
  const other = await admin.context().newPage();
  await other.goto("/access/grants");
  const row = other.getByRole("row", { name: /이임원/ });
  await expect(row).toContainText("시작 전");
  await activatePendingGrants(admin, token);
  expect((await read())[0]!.enforcement).toBe("ENFORCED");
  await expect(row).toContainText("적용 중");
  await expect(row).not.toContainText("시작 전");
});


test("setup grants apply immediately before operations start", { tag: ["@access", "@regression"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "setupgrant", "설정권한", false, "본점", "none");
  const token = bearerOf(admin);
  await grantAccess(admin, "이임원", "full", /^전체/, false);
  const response = await apiOf(admin, token)("/access/grants");
  expect(response.ok()).toBeTruthy();
  const grants = await response.json() as { enforcement: string; activates_at?: string | null }[];
  expect(grants).toHaveLength(1);
  expect(grants[0]!.enforcement).toBe("ENFORCED");
  expect(grants[0]!.activates_at).toBeNull();
});
