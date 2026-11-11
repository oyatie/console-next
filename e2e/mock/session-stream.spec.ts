// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { screens } from "../states/registry";
import { accountScreens } from "../states/account";
import { accountReads } from "./account";
import { failure, token } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const { screen, path } of [
  ...screens.filter(screen => screen.path === "/" || screen.path === "/people").map(screen => ({ screen, path: screen.path })),
  { screen: screens[0], path: "/inbox" },
  ...accountScreens.map(screen => ({ screen, path: screen.path })),
]) {
  for (const theme of ["light", "dark"] as const) test(`cold load and reload ${path}: stream before first read at 390px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await mockScreen(page, screen, "populated");
    if (path === "/account") await accountReads(page, "save-unchanged");
    await page.addInitScript(value => {
      localStorage.setItem("console.theme", value);
      const log: string[] = [];
      Object.assign(window, { streamRequests: log });
      const original = window.fetch;
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path.startsWith("/api/v1/") && !path.startsWith("/api/v1/auth/")) log.push(path);
        return original(input, init);
      };
    }, theme);
    await page.goto(path);
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await expect(page.locator("[data-route-ready]")).toHaveAttribute("data-route-ready", path);
      const requests = await page.evaluate(() => (window as unknown as { streamRequests: string[] }).streamRequests);
      expect(requests[0], "the stream opens before shell and screen reads").toBe("/api/v1/events");
      expect(requests.filter(path => path === "/api/v1/events")).toHaveLength(1);
      expect(requests).toContain(screen.read);
      expect(requests.filter(path => path === "/api/v1/users/me"), "shell and page share one identity read").toHaveLength(1);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("#main")).toBeVisible();
      await fits(page, `${screen.key} ${theme}`);
    }
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) test(`sign-in opens the stream before any screen read at 390px ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  const fixture = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "post", "/api/v1/auth/otp/redeem", { status: 200, json: token() });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
  // Wrap after init scripts so the same log sees both the mocked SSE transport and real data fetches.
  await page.evaluate(() => {
    const log: string[] = [];
    Object.assign(window, { streamRequests: log });
    const original = window.fetch;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.startsWith("/api/v1/") && !path.startsWith("/api/v1/auth/")) log.push(path);
      return original(input, init);
    };
  });
  await page.locator("summary").click();
  await page.getByRole("textbox", { name: t("auth.login.code"), exact: true }).fill("ABCD-EFGH");
  await page.getByRole("button", { name: t("auth.login.submitCode"), exact: true }).click();
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true })).toBeVisible();
  const requests = await page.evaluate(() => (window as unknown as { streamRequests: string[] }).streamRequests);
  expect(requests).toContain("/api/v1/me/action-inbox");
  expect(requests[0], "the stream opens before the first data read").toBe("/api/v1/events");
  expect(requests.filter(path => path === "/api/v1/events")).toHaveLength(1);
  expect(requests.filter(path => path === "/api/v1/users/me"), "sign-in shares the shell's identity read").toHaveLength(1);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await fits(page, `signed-in Home ${theme}`);
  expect(fixture.unexpected).toEqual([]);
});

test("a failed live chunk has one recovery screen and reload restores the same session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
  await mockRoute(page, "post", "/api/v1/auth/otp/redeem", { status: 200, json: token() });
  const liveAsset = (url: URL) => /\/live-[^/]+\.js$/.test(url.pathname);
  await page.route(liveAsset, route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/login");
  // Exercise the exhausted automatic reload, so the next recovery belongs to the user.
  await page.evaluate(() => {
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!;
    sessionStorage.setItem(`console.chunk-reload:${entry.src}`, "1");
  });
  await page.locator("summary").click();
  await page.getByRole("textbox", { name: t("auth.login.code"), exact: true }).fill("ABCD-EFGH");
  await page.getByRole("button", { name: t("auth.login.submitCode"), exact: true }).click();
  const heading = page.getByRole("heading", { name: t("common.crashed.title"), exact: true });
  await expect(heading.first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(heading).toHaveCount(1);
  await expect(heading).toBeInViewport();
  const reload = page.getByRole("button", { name: t("common.crashed.action"), exact: true });
  await expect(reload).toHaveCount(1);
  await expect(reload).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.unroute(liveAsset);
  await reload.click();
  await expect(page.getByRole("region", { name: t("home.inbox.title"), exact: true })).toBeVisible();
  await expect(heading).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
