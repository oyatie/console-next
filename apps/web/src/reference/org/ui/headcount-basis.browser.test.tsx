// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./headcount-basis.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/vite-headcount-basis-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/reference/org/ui/headcount-basis.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/headcount-basis-test*", route => route.fulfill({ contentType: "text/html", body: `<html><title>Headcount basis</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const CASES = ["en", "ko"].flatMap(lang => [{ lang, where: "chart", count: "42" }, { lang, where: "list", count: "" }]);

// Speech input presses a control by the words on it, so the name a button exposes has to hold the text it shows.
test.each(CASES)("$lang, $where: the headcount explainer is named by the text it shows", async ({ lang, where, count }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}headcount-basis-test?lang=${lang}`);
  const button = page.locator(`#${where}`).getByRole("button");
  const shown = (await button.innerText()).replace(/\s+/g, " ").trim();
  expect(shown).toContain(count);
  expect(shown.length).toBeGreaterThan(count.length);
  await element(button).toHaveAccessibleName(new RegExp(shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test.each(["pointer", "keyboard"])("the explainer still opens its panel by %s and hands focus back", async how => {
  await page.goto(`${server.resolvedUrls!.local[0]}headcount-basis-test?lang=en`);
  const button = page.locator("#chart").getByRole("button");
  if (how === "pointer") await button.click();
  else {
    await button.focus();
    await page.keyboard.press("Enter");
  }
  await element(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await element(page.getByRole("dialog")).toHaveCount(0);
  await element(button).toBeFocused();
});
