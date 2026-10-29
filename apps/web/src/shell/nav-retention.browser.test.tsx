// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { chromium, firefox, expect as element } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { navFixture } from "./nav.browser-fixture";

for (const engine of [chromium, firefox]) test(`a cold modules fault reuses only this principal's remembered readiness in ${engine.name()}`, async () => {
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
