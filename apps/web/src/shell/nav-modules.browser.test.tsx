// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { chromium, firefox, expect as element } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { AT, id } from "../../../../e2e/mock/fixtures";
import { clearShifts } from "../../../../e2e/stability";
import { navFixture, navModules } from "./nav.browser-fixture";

test("cached active support session stays visible when access and support refetches both fail", async () => {
  await loadCatalog("ko");
  const { server, browser, page, errors } = await navFixture();
  let failing = false;
  await page.route("**/api/v1/access/me", route => failing
    ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }) : route.fallback());
  await page.route("**/api/v1/support-sessions/active", route => failing
    ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } })
    : route.fulfill({ json: { sessions: [{ id: id(1), operator_label: "검증 운영자", expires_at: AT }],
      pending_count: 0, pending_approvals: [], can_approve: false } satisfies components["schemas"]["ActiveSupportSessions"] }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const banner = page.getByText(t("supportAccess.banner"), { exact: true });
    await element(banner).toBeVisible();
    failing = true;
    await page.evaluate(() => window.refetchNavDecisions());
    await element(banner).toBeVisible();
    await element(page.getByText(t("common.read.stale"), { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

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

for (const engine of [chromium, firefox]) test.each(["503", "network"])(`a cold modules %s keeps independent links and retry restores readiness without navigation in ${engine.name()}`, async fault => {
  await loadCatalog("ko");
  const { server, browser, page, errors } = await navFixture(engine);
  let unavailable = true;
  await page.route("**/api/v1/onboarding/modules", route => unavailable
    ? fault === "network" ? route.abort("failed") : route.fulfill({ status: 503, json: { error: { code: "unavailable" } } })
    : route.fulfill({ json: [{ key: "people", ready: true, unblock: null }] satisfies components["schemas"]["OnboardingModules"] }));
  try {
    await page.goto(server.resolvedUrls!.local[0]!);
    const rail = page.getByRole("navigation", { name: "주 메뉴" });
    await element(rail.getByRole("link")).toHaveText([t("shell.link.home"), t("shell.link.requests"), t("shell.link.settings")]);
    await element(rail.getByRole("alert")).toHaveCount(1);
    await element(rail.getByRole("alert").getByRole("heading")).toHaveText(t("common.loadFailed.title"));
    await page.reload();
    await element(rail.getByRole("alert")).toHaveCount(1);
    const url = page.url();
    unavailable = false;
    await rail.getByRole("button", { name: t("common.retry"), exact: true }).click();
    await element(rail.getByRole("link", { name: t("shell.link.people"), exact: true })).toBeVisible();
    await element(rail.getByRole("alert")).toHaveCount(0);
    expect(page.url()).toBe(url);
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    unavailable = true;
    await page.evaluate(() => window.refetchNavModules());
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    await rail.getByRole("link", { name: "직원", exact: true }).click();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    await page.reload();
    await element(rail.getByRole("link", { name: "직원", exact: true })).toBeVisible();
    await element(rail.getByRole("link", { name: "근태", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);
