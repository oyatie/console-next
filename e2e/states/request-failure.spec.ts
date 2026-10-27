// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { expectAxe } from "../a11y";
import { AT, checklist, failure, id, inbox, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

test("the gallery reserves the uncertain band for the keyed command", async ({ page }) => {
  await page.goto("/_gallery");
  const errors = page.locator(".gallery__section").filter({ has: page.getByRole("heading", { name: tg("section.errors"), exact: true }) });
  const band = errors.getByRole("status").filter({ hasText: t("requestOutcome.checking") });
  await expect(band).toHaveCount(1);
  await expect(band.getByRole("link", { name: t("requestOutcome.open"), exact: true })).toHaveAttribute("href", "/requests/gallery-command-intent");
  await expect(errors.getByRole("alert")).toHaveCount(2);
});

for (const row of [
  { path: "/org", read: "/api/v1/org-structure" },
  { path: "/org/entities", read: "/api/v1/legal-entities" },
  { path: "/statutory?tab=register", read: "/api/v1/statutory/workplaces" },
  { path: "/", read: "/api/v1/org-structure" },
] as const) test(`${row.path}: a read outage offers retry and reference without command uncertainty`, async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: true, phase: "OPERATING", as_of: AT, entries: [] } });
  if (row.path === "/") {
    const setup: typeof checklist = { ...checklist, phase: "SETUP", go_live_at: null, total: 1, steps: [
      { key: "org", group: "operations", state: "todo", action: "register", can_act: true, needs: "org::edit", skippable: false,
        counts: { entities: 0, workplaces: 0, units: 0, people: 0, unplaced: 0, entity_unknown: 0 }, paths: [] },
    ] };
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, tenant: { ...user.tenant!, phase: "SETUP", go_live_at: null } } });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: setup });
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(0), setup } });
  }
  let failing = true;
  let attempts = 0;
  await mockRoute(page, "get", "/api/v1/statutory/workplaces", { status: 200, json: [] });
  await page.route(url => url.pathname === row.read, route => {
    attempts++;
    return failing ? route.fulfill({ status: 503, json: { error: { ...failure("walk_outage").error, message: "walk: simulated outage", support_ref: id(98), support_ref_at: "2026-10-27T00:00:00Z" } } }) : route.fallback();
  });
  try {
    await page.goto(row.path);
    const main = page.getByRole("main");
    await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
    await expect(main).not.toContainText(t("requestOutcome.checking"));
    await expect(main).not.toContainText("walk: simulated outage");
    await expect(main.getByRole("link", { name: t("requestOutcome.open"), exact: true })).toHaveCount(0);
    await expect(main.locator(`[data-support-reference="${id(98)}"]`)).toBeVisible();
    await expectAxe(page, `${row.path} read outage`);
    const before = attempts;
    failing = false;
    await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
    await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toHaveCount(0);
    expect(attempts).toBeGreaterThan(before);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

test("a command lost after send stays uncertain through a failed lookup, then settles by read alone", async ({ page }) => {
  const fixture = await mockScreen(page, screens[2], "populated");
  const displayName = tg("sample.person", { n: 1 });
  let writes = 0;
  let reads = 0;
  let readAvailable = false;
  await page.route(url => url.pathname === "/api/v1/users/me", async route => {
    if (route.request().method() === "PATCH") {
      writes++;
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({ display_name: displayName });
      return route.abort("connectionreset");
    }
    reads++;
    return route.fulfill(readAvailable ? { json: { ...user, display_name: displayName } } : { status: 503, json: failure("walk_outage") });
  });
  try {
    await page.goto("/_gallery");
    const command = page.locator("section").filter({ has: page.getByRole("heading", { name: t("account.name.edit"), exact: true }) });
    const submit = command.getByRole("button", { name: t("account.name.edit"), exact: true });
    await submit.click();
    const band = command.getByRole("status").filter({ hasText: t("requestOutcome.checking") });
    await expect(band).toBeVisible();
    await expect(submit).toBeDisabled();
    expect(writes).toBe(1);
    await band.getByRole("button", { name: t("requestOutcome.check"), exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    await expect(band).toBeVisible();
    await expect(submit).toBeDisabled();
    readAvailable = true;
    await band.getByRole("button", { name: t("requestOutcome.check"), exact: true }).click();
    await expect(command.getByRole("status")).toHaveText(displayName);
    await expect(submit).toBeEnabled();
    expect(reads).toBe(2);
    expect(writes).toBe(1);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
