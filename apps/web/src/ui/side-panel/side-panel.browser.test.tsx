// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./side-panel.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/side-panel-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/side-panel/side-panel.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/panel-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Panel test</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("Chromium: a nested modal owns Escape, then the peek restores its row", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}panel-test`);
  const row = page.getByRole("button", { name: "Open peek", exact: true });
  await row.click();
  await element(page.getByRole("heading", { name: "Panel heading" })).toBeFocused();
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  await element(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await element(page.getByRole("dialog")).toHaveCount(0);
  await element(page.getByRole("complementary")).toBeVisible();
  await element(page.getByRole("button", { name: "Open dialog", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await element(page.getByRole("complementary")).toHaveCount(0);
  await element(row).toBeFocused();
});

test("Chromium: pending reads keep focus, handled/composing Escape stays local, and the background stays live", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}panel-test`);
  await page.getByRole("button", { name: "Open peek", exact: true }).click();
  const panel = page.getByRole("complementary");
  const picker = page.getByRole("button", { name: "Expanded picker" });
  await picker.press("Escape");
  await element(panel).toBeVisible();
  await element(panel.getByRole("region", { name: "Panel heading" })).toHaveCount(0);
  const heading = panel.getByRole("heading");
  await heading.focus();
  for (const mode of ["handled", "composing"]) {
    await heading.evaluate((el, kind) => {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: kind === "composing" });
      if (kind === "handled") event.preventDefault();
      el.dispatchEvent(event);
    }, mode);
    await element(panel).toBeVisible();
  }
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await element(panel.locator('[aria-busy="true"]').first()).toBeVisible();
  // Rerendering must not repeatedly move focus to the heading.
  expect(await heading.evaluate(el => el === document.activeElement)).toBe(false);
  await page.getByRole("button", { name: "Outside control" }).click();
  await page.keyboard.press("Escape");
  await element(panel).toBeVisible();
  await element(page.getByRole("button", { name: "Outside control" })).toBeFocused();
  await heading.focus();
  await page.keyboard.press("Escape");
  await element(panel).toHaveCount(0);
  await element(page.getByRole("button", { name: "Open peek", exact: true })).toBeFocused();
});

test.each([1280, 1279, 640, 639])("Chromium: the panel changes placement at its boundaries (%spx)", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}panel-test`);
  await page.getByRole("button", { name: "Open peek", exact: true }).click();
  const panel = page.getByRole("complementary");
  await element(panel).toBeVisible();
  const layout = await panel.evaluate(el => ({ position: getComputedStyle(el).position, top: el.getBoundingClientRect().top, width: el.getBoundingClientRect().width }));
  expect(layout.position).toBe(width < 1280 ? "fixed" : "sticky");
  if (width < 1280) {
    const layer = await panel.evaluate(el => ({ actual: getComputedStyle(el).zIndex, token: getComputedStyle(document.documentElement).getPropertyValue("--z-panel").trim() }));
    expect(layer.token).not.toBe("");
    expect(layer.actual).toBe(layer.token);
    if (width < 768) {
      const railLayer = await page.locator(".rail").evaluate(el => Number(getComputedStyle(el).zIndex));
      expect(Number(layer.actual)).toBeGreaterThan(railLayer);
    }
  }
  expect(Math.round(layout.width)).toBe(width < 640 ? width : 440);
  if (width < 640) expect(layout.top).toBe(0);
  await element(panel.getByRole("button", { name: "돌아가기", exact: true })).toBeVisible({ visible: width < 640 });
  await element(panel.getByRole("button", { name: "상세 패널 닫기", includeHidden: true })).toBeVisible({ visible: width >= 640 });
  // WCAG 2.4.11: the overlay can be dismissed from its focused heading at every narrow width.
  await page.keyboard.press("Escape");
  await element(panel).toHaveCount(0);
  await element(page.getByRole("button", { name: "Open peek", exact: true })).toBeFocused();
});

test.each([1440, 390])("Chromium: Dialog and Sheet consume size tokens and fit %spx", async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server.resolvedUrls!.local[0]}panel-test`);
  for (const [trigger, token, wanted] of [["Small dialog", "--dialog-w-sm", 400], ["Medium dialog", "--dialog-w-md", 480], ["Default sheet", "--sheet-w", 560], ["Large sheet", "--sheet-w-lg", 728]] as const) {
    await page.getByRole("button", { name: trigger, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await element(dialog).toBeVisible();
    const modal = dialog.locator("..");
    expect(Math.round((await modal.boundingBox())!.width)).toBe(Math.min(wanted, width - (trigger.includes("dialog") ? 32 : 0)));
    // A token override must change the rendered size, including the named large-sheet formula.
    await page.evaluate(([name]) => document.documentElement.style.setProperty(name!, "320px"), [token]);
    expect(Math.round((await modal.boundingBox())!.width)).toBe(320);
    await page.keyboard.press("Escape");
    await element(dialog).toHaveCount(0);
    await page.evaluate(([name]) => document.documentElement.style.removeProperty(name!), [token]);
  }
});
