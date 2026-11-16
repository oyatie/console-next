// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { user } from "../e2e/mock/fixtures";
import { clearShifts } from "../e2e/stability";
import { navFixture, navModules } from "../apps/web/src/shell/nav.browser-fixture";

async function probe(passkeyDelay: number) {
  const { server, browser, page } = await navFixture();
  let phase = "SETUP";
  await page.route("**/api/v1/onboarding/modules", route => route.fulfill({ json: navModules(phase) }));
  await page.route("**/api/v1/users/me", route => route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase } } }));
  await page.route("**/api/v1/onboarding/checklist", route => route.fulfill({ json: { phase, steps: [
    { state: "todo", action: "create_legal_entity" }, { state: "todo", action: "register_employee" }, { state: "todo", action: "add_role" },
  ] } }));
  await page.route("**/api/v1/onboarding/go-live/preview", route => route.fulfill({ json: {
    phase: "SETUP", digest: "preview", line_digests: {}, blockers: [], warnings: [], becomes_governed: [],
    facts: { entities: 1, workplaces: 1, staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0, org_units: 1, employees: 1, employees_starting_later: 0, setup_writes: 0, prepared_grants: 0, grants_effective_in_setup: 0, hr_accounts_invited: 0, hr_accounts_enrolled: 0 }, breakdown: [], roles_becoming_active: [], access_admin_holders: [], hr_accounts_with_no_grant: [],
  } }));
  await page.route("**/api/v1/auth/passkey/login/start", async route => {
    await new Promise(done => setTimeout(done, passkeyDelay));
    await route.fulfill({ json: { ceremony_id: "ceremony", challenge: { publicKey: {} } } });
  });
  await page.route("**/api/v1/onboarding/go-live", async route => {
    await new Promise(done => setTimeout(done, 1500));
    phase = "OPERATING";
    await route.fulfill({ json: { phase, go_live_at: user.tenant!.go_live_at, notified: 1 } });
  });
  await loadCatalog("ko");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}setup/go-live`);
    const rail = page.getByRole("navigation", { name: t("shell.nav") });
    await element(page.getByRole("button", { name: t("setup.golive.start"), exact: true })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(done => setTimeout(done, 600)));
    await page.evaluate(clearShifts);
    await page.getByRole("button", { name: t("setup.golive.start"), exact: true }).click();
    await element(rail.getByRole("link", { name: t("shell.link.attendance"), exact: true })).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => new Promise(done => setTimeout(done, 1000)));
    return await page.evaluate(() => window.__shifts);
  } finally {
    await browser.close();
    await server.close();
  }
}

test.each([0, 700])("go-live command chain stays attended with a %i ms passkey answer", async delay => {
  expect(await probe(delay)).toEqual([]);
}, 60_000);
