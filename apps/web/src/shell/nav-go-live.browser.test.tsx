// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { user } from "../../../../e2e/mock/fixtures";
import { clearShifts } from "../../../../e2e/stability";
import { navFixture, navModules } from "./nav.browser-fixture";

test("go-live updates the rail with its answer despite a 1.5 s profile read, then keeps it on return to /people", async () => {
  const { server, browser, page, errors } = await navFixture();
  let phase = "SETUP", hold = false;
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  let releaseModules!: () => void;
  const pendingModules = new Promise<void>(done => { releaseModules = done; });
  let moduleReads = 0;
  await page.route("**/api/v1/onboarding/modules", async route => {
    moduleReads++;
    if (phase === "OPERATING") await pendingModules;
    await route.fulfill({ json: navModules(phase) });
  });
  await page.route("**/api/v1/users/me", async route => {
    if (phase === "OPERATING") await new Promise(done => setTimeout(done, 1500));
    if (hold) await pending;
    await route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase } } });
  });
  await page.route("**/api/v1/onboarding/checklist", route => route.fulfill({ json: { phase, steps: [
    { state: "todo", action: "create_legal_entity" }, { state: "todo", action: "register_employee" }, { state: "todo", action: "add_role" },
  ] } }));
  await page.route("**/api/v1/onboarding/go-live/preview", route => route.fulfill({ json: {
    phase: "SETUP", digest: "preview", line_digests: {}, blockers: [], warnings: [], becomes_governed: [],
    facts: { entities: 1, workplaces: 1, staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0, org_units: 1, employees: 1, employees_starting_later: 0, setup_writes: 0, prepared_grants: 0, grants_effective_in_setup: 0, hr_accounts_invited: 0, hr_accounts_enrolled: 0 }, breakdown: [], roles_becoming_active: [], access_admin_holders: [], hr_accounts_with_no_grant: [],
  } }));
  await page.route("**/api/v1/auth/passkey/login/start", route => route.fulfill({ json: { ceremony_id: "ceremony", challenge: { publicKey: {} } } }));
  await page.route("**/api/v1/onboarding/go-live", route => { phase = "OPERATING"; return route.fulfill({ json: { phase, go_live_at: user.tenant!.go_live_at, notified: 1 } }); });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    await rail.getByRole("link", { name: "직원", exact: true }).click();
    await element.poll(() => page.evaluate(() => window.__navFacts.phase)).toBe("SETUP");
    await page.getByRole("link", { name: "Start operations" }).click();
    await element(page.getByRole("button", { name: "운영 시작", exact: true })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(clearShifts);
    const refetched = page.waitForResponse("**/api/v1/users/me");
    const modulesRequested = page.waitForRequest("**/api/v1/onboarding/modules");
    await page.getByRole("button", { name: "운영 시작", exact: true }).click();
    await modulesRequested;
    await element(page.getByRole("button", { name: "운영 시작", exact: true })).toBeDisabled();
    expect(new URL(page.url()).pathname).toBe("/setup/go-live");
    expect(moduleReads).toBe(2);
    releaseModules();
    await element(page).toHaveURL(server.resolvedUrls!.local[0]!);
    await element(rail.getByRole("link", { name: "근태", exact: true })).toBeVisible();
    await element(rail.getByRole("link", { name: "법정 신고·서류", exact: true })).toBeVisible();
    await refetched;
    await element(rail.getByRole("link", { name: "근태", exact: true })).toBeVisible();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__shifts)).toEqual([]);
    const orgRead = page.waitForResponse("**/api/v1/users/me");
    await rail.getByRole("link", { name: "조직 구조", exact: true }).click();
    await orgRead;
    await element.poll(() => page.evaluate(() => window.__navFacts.phase)).toBe("OPERATING");
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(done => setTimeout(done, 600)));
    await page.evaluate(clearShifts);
    const entries = await rail.getByRole("link").allTextContents();
    hold = true;
    const requested = page.waitForRequest("**/api/v1/users/me");
    await page.evaluate(() => history.pushState({ ...history.state, __TSR_key: "return-to-people" }, "", "/people"));
    await requested;
    await element(rail.getByRole("link")).toHaveText(entries);
    await page.evaluate(() => new Promise(done => setTimeout(done, 600)));
    expect(await page.evaluate(() => window.__shifts)).toEqual([]);
    release();
    await element.poll(() => page.evaluate(() => window.__navFacts.phase)).toBe("OPERATING");
    await element(rail.getByRole("link")).toHaveText(entries);
    expect(moduleReads).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    releaseModules();
    release();
    await browser.close();
    await server.close();
  }
}, 60_000);
