// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiAs, soloTenant } from "./chaos";
import { acceptConsent, go, vendorPage } from "./flows";
import { setupCompany } from "./setup-flows";
import { publishTestTerms } from "./terms-fixture";

// The serial clock project owns global time changes: publishing terms changes every tenant's current document.
test("BL-015: a newer immutable document restores the blocker and asks for its exact text", { tag: ["@first-run", "@negative", "@clock"] }, async ({ browser }, info) => {
  const admin = await soloTenant(browser, "ideal-terms-version", "개정약관그룹");
  const read = apiAs(admin);
  await setupCompany(admin, "개정약관정밀", "본사");
  await go(admin, "/setup/go-live");
  await admin.getByRole("button", { name: "이용약관 읽기" }).click();
  const accept = admin.getByRole("button", { name: "고객 계정을 대표해 이용약관 동의" });
  await accept.click();
  await expect(accept).toBeHidden();
  const version = `e2e-v${info.repeatEachIndex + 2}` as const;
  const vendor = await vendorPage(browser);
  await publishTestTerms(version);
  // Publication interrupts an idle screen through SSE, before any request or navigation.
  await expect(admin).toHaveURL(/\/setup-passkey$/);
  await expect(vendor).toHaveURL(/\/setup-passkey$/);
  await vendorPage(browser);
  await expect(vendor).not.toHaveURL(/\/setup-passkey$/);
  await acceptConsent(admin);
  await admin.getByRole("button", { name: "동의하고 계속", exact: true }).click();
  await expect(admin).not.toHaveURL(/\/setup-passkey$/);
  await expect(admin).toHaveURL(/\/setup\/go-live$/);
  await go(admin, "/setup/go-live");
  await expect(admin.getByRole("alert", { name: "고객 계정의 이용약관 동의가 없습니다" })).toBeVisible();
  await admin.getByRole("button", { name: "이용약관 읽기" }).click();
  await expect(admin.getByRole("term").filter({ hasText: /^버전$/ }).locator("..").getByRole("definition")).toHaveText(version);
  await expect(admin.getByText("Revised E2E service terms fixture. This is a test document, not a published contract.", { exact: true })).toBeVisible();
  const latest = await read<{ sha256: string }>("/api/v1/onboarding/terms");
  let payload: { version: string; sha256: string } | null = null;
  await admin.route("**/api/v1/onboarding/terms", async (r) => {
    if (r.request().method() === "POST") payload = r.request().postDataJSON();
    await r.continue();
  });
  await accept.click();
  await expect(accept).toBeHidden();
  expect(payload).toEqual({ version, sha256: latest.sha256 });
  const preview = await read<{ blockers: { code: string }[] }>("/api/v1/onboarding/go-live/preview");
  expect(preview.blockers.some((b) => b.code === "terms_not_accepted")).toBe(false);
  await expectAccessible(admin, "ideal terms new version accepted");
  await admin.screenshot({ path: info.outputPath("new-version-accepted.png"), fullPage: true });
});
