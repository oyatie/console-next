// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { browserEngine } from "../lib/browser-test";
import { navFixture } from "./nav.browser-fixture";

test("support approval changes only on navigation, including revocation", async () => {
  const { server, browser, page, errors } = await navFixture(browserEngine());
  let approved = false;
  await page.route("**/api/v1/support-sessions/active", route => route.fulfill({ json: {
    sessions: [], pending_count: 0, pending_approvals: [], can_approve: approved,
  } }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    for (const value of [true, false]) {
      approved = value;
      const before = await rail.getByRole("link").allTextContents();
      await page.evaluate(() => window.refetchNavDecisions());
      await element(rail.getByRole("link")).toHaveText(before);
      await page.evaluate(path => history.pushState({}, "", path), value ? "/people" : "/org");
      await element(rail.getByRole("link", { name: "감사 기록", exact: true })).toHaveCount(value ? 1 : 0);
    }
    approved = true;
    await page.evaluate(() => window.refetchNavDecisions());
    await element(rail.getByRole("link", { name: "감사 기록", exact: true })).toHaveCount(0);
    // The fixture switches principal on /org without changing the pathname.
    await page.evaluate(() => window.switchNavPrincipal());
    await element(rail.getByRole("link", { name: "감사 기록", exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

test.each([404, 429])("an in-session users/me %i keeps the displayed rail until the principal changes", async status => {
  const { server, browser, page, errors } = await navFixture(browserEngine());
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    const before = await rail.getByRole("link").allTextContents();
    await page.route("**/api/v1/users/me", route => route.fulfill({ status, json: { error: { code: "unavailable" } } }));
    const refused = page.waitForResponse(response => response.url().endsWith("/api/v1/users/me") && response.status() === status);
    await page.evaluate(() => history.pushState({}, "", "/people"));
    await refused;
    await element.poll(() => page.evaluate(() => window.__navFacts.state)).toBe("error");
    await element(rail.getByRole("link")).toHaveText(before);
    await page.evaluate(() => window.switchNavPrincipal());
    await element(rail.getByRole("link")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

test("a cold support fault shows one error and one retry, then recovers immediately", async () => {
  const { server, browser, page, errors } = await navFixture(browserEngine());
  let failed = true;
  await page.route("**/api/v1/support-sessions/active", route => failed
    ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }) : route.fallback());
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.getByRole("button", { name: "메뉴", exact: true }).click();
    await element(page.getByRole("alert")).toHaveCount(1);
    await element(page.getByRole("button", { name: "다시 불러오기", exact: true })).toHaveCount(1);
    await page.keyboard.press("Escape");
    failed = false;
    await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
    await page.getByRole("button", { name: "메뉴", exact: true }).click();
    await element(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "직원", exact: true })).toBeVisible();
    await element(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);
