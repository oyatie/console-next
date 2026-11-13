// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { firefox, expect as element } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { chromium } from "../lib/browser-test";
import { navFixture } from "./nav.browser-fixture";
import { checklist, user } from "../../../../e2e/mock/fixtures";

for (const engine of [chromium, ...(process.env.E2E_XBROWSER === "1" ? [firefox] : [])]) test.each([503, 403])(`one shell retry respects the checklist's %i answer in ${engine.name()}`, async status => {
  await loadCatalog("ko");
  const { server, browser, page, errors } = await navFixture(engine);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  let failing = true;
  let reads = 0;
  await page.route("**/api/v1/users/me", route => route.fulfill({ json: { ...user, tenant: { ...user.tenant, phase: "SETUP", go_live_at: null } } }));
  await page.route("**/api/v1/onboarding/checklist", route => {
    reads++;
    return failing ? route.fulfill({ status, json: { error: { code: status === 403 ? "forbidden" : "unavailable" } } })
      : route.fulfill({ json: { ...checklist, phase: "SETUP", go_live_at: null } });
  });
  for (const path of ["onboarding/modules", "support-sessions/active"]) await page.route(`**/api/v1/${path}`, route => failing
    ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }) : route.fallback());
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const failure = page.getByRole("main").getByRole("alert");
    await element(failure).toHaveCount(1);
    const before = reads;
    expect(before).toBeGreaterThan(0);
    failing = false;
    await failure.getByRole("button", { name: t("common.retry"), exact: true }).click();
    await element(page.getByRole("navigation", { name: t("shell.nav") }).getByRole("alert")).toHaveCount(0);
    await element(failure).toHaveCount(0);
    await expect.poll(() => reads).toBe(before + (status === 503 ? 1 : 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

for (const engine of [chromium, ...(process.env.E2E_XBROWSER === "1" ? [firefox] : [])]) test(`a cold modules fault reuses only this principal's remembered readiness in ${engine.name()}`, async () => {
  await loadCatalog("ko");
  const { server, browser, page, errors } = await navFixture(engine);
  let failing = false;
  await page.route("**/api/v1/onboarding/modules", route => failing
    ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }) : route.fallback());
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: t("shell.nav") });
    await element(rail.getByRole("link", { name: t("shell.link.people"), exact: true })).toBeVisible();
    const entries = await rail.getByRole("link").allTextContents();
    failing = true;
    await page.reload();
    await element(rail.getByRole("alert")).toHaveCount(1);
    await element(rail.getByRole("link")).toHaveText(entries);
    await page.evaluate(() => window.switchNavPrincipal());
    await element(rail.getByRole("link")).toHaveText([t("shell.link.home"), t("shell.link.requests"), t("shell.link.settings")]);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

test.each(["failed", "held"])("%s shell reads retain the answered rail across reloads for only this principal", async state => {
  await loadCatalog("ko");
  const { server, browser, page } = await navFixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.resolvedUrls!.local[0]!);
  const rail = page.getByRole("navigation", { name: t("shell.nav") });
  await element(rail.getByRole("link", { name: t("shell.link.people"), exact: true })).toBeVisible();
  const entries = await rail.getByRole("link").allTextContents();
  const positions = await rail.getByRole("link").evaluateAll(links => links.map(link => {
    const { y, height } = link.getBoundingClientRect(); return { y, height };
  }));
  const paths = ["access/me", "users/me", "support-sessions/active"];
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  for (const path of paths) await page.route(`**/api/v1/${path}`, async route => {
    if (state === "held") await held;
    if (!page.isClosed()) await route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
  });
  try {
    const requested = page.waitForRequest("**/api/v1/access/me");
    await page.reload();
    await requested;
    await element(rail.getByRole("link")).toHaveText(entries);
    expect(await rail.getByRole("link").evaluateAll(links => links.map(link => {
      const { y, height } = link.getBoundingClientRect(); return { y, height };
    }))).toEqual(positions);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("console.nav.")) {
        localStorage.setItem(key.replace(/.$/, "other-principal"), localStorage.getItem(key)!);
        localStorage.removeItem(key);
      }
    });
    await page.reload();
    await element(rail.getByRole("status")).toBeVisible();
    await element(rail.getByRole("link")).toHaveCount(0);
  } finally {
    release();
    await browser.close();
    await server.close();
  }
}, 60_000);
