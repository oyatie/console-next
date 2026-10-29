// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import type { components } from "@console/api";
import { clearShifts } from "../../../../e2e/stability";
import { navFixture, navModules } from "./nav.browser-fixture";

test("late module readiness stays cached until navigation, including return to an earlier page", async () => {
  const { server, browser, page, errors } = await navFixture();
  let ready = false, reads = 0;
  await page.route("**/api/v1/onboarding/modules", route => {
    reads++;
    const modules: components["schemas"]["OnboardingModules"] = (["org", "access", "people", "attendance", "statutory"] as const).map(key => ({
      key, ready: key !== "attendance" || ready, unblock: key === "attendance" && !ready ? "register_employee" : null,
    }));
    return route.fulfill({ json: modules });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    await rail.getByRole("link", { name: "직원", exact: true }).click();
    await element(page).toHaveURL(/\/people$/);
    expect(reads).toBe(1);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.evaluate(clearShifts);
    ready = true;
    await page.evaluate(() => window.refetchNavModules());
    await page.waitForTimeout(600);
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__shifts)).toEqual([]);
    await rail.getByRole("link", { name: "조직 구조", exact: true }).click();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toBeVisible();
    await rail.getByRole("link", { name: "직원", exact: true }).click();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toBeVisible();
    expect(reads).toBe(2);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

test("a readiness command refreshes the shared modules cache once without a navigation read", async () => {
  const { server, browser, page, errors } = await navFixture();
  let ready = false, reads = 0;
  await page.route("**/api/v1/onboarding/modules", route => {
    reads++;
    return route.fulfill({ json: navModules(ready ? "OPERATING" : "SETUP") });
  });
  await page.route("**/api/v1/onboarding/steps/org/skip", route => {
    ready = true;
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    const refreshed = page.waitForResponse("**/api/v1/onboarding/modules");
    await page.getByRole("button", { name: "Complete setup" }).click();
    await refreshed;
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    await rail.getByRole("link", { name: "직원", exact: true }).click();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toBeVisible();
    await rail.getByRole("link", { name: "홈", exact: true }).click();
    await element(page).toHaveURL(server.resolvedUrls!.local[0]!);
    expect(reads).toBe(2);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

test("a cold modules 503 shows skeleton hubs and a failed refresh keeps last good readiness", async () => {
  const { server, browser, page, errors } = await navFixture();
  let unavailable = true;
  await page.route("**/api/v1/onboarding/modules", route => unavailable
    ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } })
    : route.fulfill({ json: [{ key: "people", ready: true, unblock: null }] satisfies components["schemas"]["OnboardingModules"] }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("status")).toBeVisible();
    await element(rail.getByRole("link")).toHaveCount(0);
    unavailable = false;
    await page.evaluate(() => window.refetchNavModules());
    await rail.getByRole("link", { name: "직원", exact: true }).click();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    unavailable = true;
    await page.evaluate(() => window.refetchNavModules());
    await rail.getByRole("link", { name: "홈", exact: true }).click();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);
