// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { authz, checklist, failure, user } from "../../../../e2e/mock/fixtures";
import { navFixture } from "./nav.browser-fixture";

beforeAll(() => loadCatalog("ko"));

test("the current operating identity shows and dismisses the same receipt before the full checklist returns", async () => {
  const { server, browser, page } = await navFixture();
  const held = Promise.withResolvers<void>();
  const goLiveAt = new Date().toISOString();
  await page.route("**/api/v1/users/me", route => route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase: "OPERATING", go_live_at: goLiveAt } } }));
  await page.route("**/api/v1/settings", route => route.fulfill({ json: { items: [{ key: "onboarding.receipt_days", value: 2 }] } }));
  await page.route("**/api/v1/me/authz", route => route.fulfill({ json: authz }));
  await page.route("**/api/v1/onboarding/checklist", async route => {
    await held.promise;
    await route.fulfill({ json: { ...checklist, go_live_at: goLiveAt } });
  });
  try {
    const requested = page.waitForRequest("**/api/v1/onboarding/checklist");
    await page.goto(new URL("/people", server.resolvedUrls!.local[0]!).href);
    await requested;
    const band = page.locator('header [data-phase-band="started"]');
    await element(band).toBeVisible();
    await element(page.locator("[data-phase-pending]")).toHaveCount(0);
    await band.getByRole("button", { name: t("setup.phase.dismiss") }).click();
    const answered = page.waitForResponse("**/api/v1/onboarding/checklist");
    held.resolve();
    await answered;
    await element(band).toHaveCount(0);
    expect(await page.evaluate(() => Object.values(localStorage))).toContain(`OPERATING:${goLiveAt}`);
  } finally { held.resolve(); await browser.close(); await server.close(); }
}, 60_000);

test.each(["receipt", "expired", "checklist-503"])("a slow access read paints the head once: %s", async outcome => {
  const { server, browser, page } = await navFixture();
  const access = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<void>();
  await page.route("**/api/v1/access/me", async route => {
    await access.promise;
    await route.fallback();
  });
  await page.route("**/api/v1/me/authz", route => route.fulfill({ json: authz }));
  await page.route("**/api/v1/settings", route => route.fulfill({ json: { can_change: false, items: [{ key: "onboarding.receipt_days", value: 2 }] } }));
  await page.route("**/api/v1/onboarding/checklist", route => route.fulfill(outcome === "checklist-503"
    ? { status: 503, json: failure("service_unavailable") }
    : { json: { ...checklist, go_live_at: new Date(Date.now() - (outcome === "expired" ? 3 * 86400000 : 0)).toISOString() } }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    await element(page.getByRole("main").getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
    const heading = page.getByRole("heading", { name: "Setup", exact: true });
    await element(heading).toHaveCount(0);
    await element(page.locator("header [data-phase-band]")).toHaveCount(0);
    access.resolve();
    await element(heading).toBeVisible();
    await element(page.locator("header [data-phase-band]")).toHaveCount(outcome === "receipt" ? 1 : 0);
    const head = heading.locator("xpath=ancestor::header");
    const before = await head.boundingBox();
    await page.evaluate(() => window.refetchNavDecisions());
    expect(await head.boundingBox()).toEqual(before);
    await element(heading).toHaveCount(1);
    const requested = page.waitForRequest("**/api/v1/onboarding/checklist");
    await page.route("**/api/v1/onboarding/checklist", async route => {
      await refresh.promise;
      await route.fulfill({ status: 503, json: failure("service_unavailable") });
    });
    await page.evaluate(() => { void window.__refetchChecklist(); });
    await requested;
    await element(heading).toBeVisible();
    refresh.resolve();
  } finally { access.resolve(); refresh.resolve(); await browser.close(); await server.close(); }
}, 60_000);

test("a refused access read leaves the phase slot quiet", async () => {
  const { server, browser, page } = await navFixture();
  await page.route("**/api/v1/access/me", route => route.fulfill({ status: 403, json: failure("forbidden") }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    await element(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
    const slot = page.locator("header [data-phase-band]");
    await element(slot).toHaveCount(0);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

test("the receipt stays in the page head, dismisses across reloads, and stays out of print with the skip link", async () => {
  const { server, browser, page } = await navFixture();
  const goLiveAt = new Date().toISOString();
  await page.route("**/api/v1/settings", route => route.fulfill({ json: { can_change: false, items: [{ key: "onboarding.receipt_days", value: 2 }] } }));
  await page.route("**/api/v1/me/authz", route => route.fulfill({ json: authz }));
  await page.route("**/api/v1/onboarding/checklist", route => route.fulfill({ json: { ...checklist, go_live_at: goLiveAt } }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const receipt = page.locator('header [data-phase-band]').filter({ hasText: t("setup.receipt.started.title") });
    const assertPlacement = async () => {
      await element(receipt).toHaveCount(1);
      const band = await receipt.boundingBox();
      const head = await page.getByRole("heading", { name: "Setup", exact: true }).boundingBox();
      expect(band!.y).toBeGreaterThanOrEqual(head!.y + head!.height);
    };
    await assertPlacement();
    await page.reload();
    await assertPlacement();
    await page.emulateMedia({ media: "print" });
    await element(receipt).toBeHidden();
    await element(page.getByRole("link", { name: t("shell.skip"), includeHidden: true })).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("button", { name: t("setup.phase.dismiss"), exact: true }).click();
    await element(receipt).toHaveCount(0);
    await element(page.locator("header [data-phase-band]")).toHaveCount(0);
    await page.reload();
    await element(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
    await element(receipt).toHaveCount(0);
    await element(page.locator("header [data-phase-band]")).toHaveCount(0);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("console.phase.dismissed.")) {
        localStorage.setItem(`${key}.other`, localStorage.getItem(key)!);
        localStorage.removeItem(key);
      }
    });
    await page.reload();
    await assertPlacement();
  } finally { await browser.close(); await server.close(); }
}, 60_000);

test("the hold deadline releases a hung checklist once and stays settled on navigation", async () => {
  const { server, browser, page } = await navFixture();
  const held = Promise.withResolvers<void>();
  await page.route("**/api/v1/me/authz", route => route.fulfill({ json: authz }));
  await page.route("**/api/v1/onboarding/checklist", async route => {
    await held.promise;
    await route.fallback();
  });
  try {
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.goto(server.resolvedUrls!.local[0]!);
    const pending = page.locator("[data-phase-pending]");
    await element(pending).toHaveAttribute("inert", "");
    const heading = page.getByRole("heading", { name: "Setup", exact: true });
    await page.clock.runFor(1_999);
    await element(heading).toHaveCount(0);
    await page.clock.runFor(1);
    await element(heading).toBeVisible();
    await element(pending).toHaveCount(0);
    await element(page.locator("header [data-phase-band]")).toHaveCount(0);
    await page.getByRole("link", { name: "Period locks", exact: true }).click();
    await element(heading).toBeVisible();
    await element(pending).toHaveCount(0);
    await page.evaluate(() => { void window.__refetchChecklist(); });
    await element(heading).toBeVisible();
    await element(pending).toHaveCount(0);
  } finally { held.resolve(); await browser.close(); await server.close(); }
}, 60_000);
