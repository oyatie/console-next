// SPDX-License-Identifier: LicenseRef-Proprietary
import type { GoLivePreview } from "@console/api/pending";
import { expect, test } from "@playwright/test";
import { go } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { setupCompany, startOperations, tenantBeforeSetup } from "./setup-flows";

test("go-live receipt preserves the confirmed facts and refuses an account without setup access", async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin, exec } = await tenantBeforeSetup(browser, "receipt", "운영기록", false, "none");
  const adminBearer = bearerOf(admin), execBearer = bearerOf(exec);
  await go(admin, "/setup/go-live");
  await go(exec, "/account");
  const api = apiOf(admin, adminBearer);
  const missing = await api("/onboarding/go-live/receipt");
  expect(missing.status()).toBe(404);
  expect(await codeOf(missing)).toBe("go_live_receipt_not_found");
  const denied = await apiOf(exec, execBearer)("/onboarding/go-live/receipt");
  expect(denied.status()).toBe(403);
  expect(await codeOf(denied)).toBe("forbidden");
  let lastPreview: GoLivePreview | undefined;
  let confirmed: GoLivePreview | undefined;
  admin.on("response", async response => {
    if (response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/onboarding/go-live/preview" && response.ok()) {
      lastPreview = await response.json();
    }
  });
  admin.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/onboarding/go-live") confirmed = lastPreview;
  });
  await setupCompany(admin, "운영기록", "본사");
  const command = admin.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/onboarding/go-live");
  await startOperations(admin);
  const response = await api("/onboarding/go-live/receipt");
  expect(response.status()).toBe(200);
  const receipt = await response.json();
  expect(receipt.preview_digest).toBe(confirmed!.digest);
  expect(receipt.go_live_at).toBe((await (await command).json()).go_live_at);
  expect(receipt.go_live_by).toEqual(expect.any(String));
  expect(receipt.facts_snapshot).toMatchObject({ phase_is_setup: true, entities: 1, workplaces: 1, org_units: 1, terms_accepted: true });
  expect(receipt.facts_snapshot).toEqual(confirmed!.facts);
  expect(receipt.facts_snapshot_version).toBe(1);
  await admin.reload();
  expect(await (await api("/onboarding/go-live/receipt")).json()).toEqual(receipt);
});
