// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { screens } from "../states/registry";
import { failure, token } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

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
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await fits(page, `signed-in Home ${theme}`);
  expect(fixture.unexpected).toEqual([]);
});
