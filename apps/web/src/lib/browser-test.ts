// SPDX-License-Identifier: LicenseRef-Proprietary
import type { DepOptimizationOptions } from "vite";
import type { Locator, Page } from "@playwright/test";
export { chromium, type Browser, type Page } from "@playwright/test";

// Virtual fixtures evade Vite's scanner; prebundle their shared dependencies before the browser loads React.
export const browserTestOptimizeDeps: DepOptimizationOptions = {
  include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@tanstack/react-query", "@tanstack/react-router", "intl-messageformat", "lucide-react", "openapi-fetch", "react-aria-components"],
};

export async function openBrowserTestPage(page: Page, url: string, ready: Locator) {
  await page.goto(url, { waitUntil: "commit", timeout: 0 });
  await waitForBrowserTestPage(page, ready);
}

export async function waitForBrowserTestPage(page: Page, ready: Locator) {
  // The enclosing Vitest hook/test owns the budget; unrelated resources are not a render signal.
  await ready.waitFor({ timeout: 0 });
  await page.evaluate(() => document.fonts.ready);
}
