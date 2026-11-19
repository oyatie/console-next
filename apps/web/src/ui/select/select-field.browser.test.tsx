// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, selectTrigger, type Browser, type Page } from "../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./select-field.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/select-field-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/ui/select/select-field.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/select-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Select test</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const open = async (width: number, which = "filing") => {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${server.resolvedUrls!.local[0]}select-test?case=${which}`);
};
const list = () => page.getByRole("listbox");
const box = async (target: Locator) => (await target.boundingBox())!;

test.each(["keyboard", "pointer"])("the trigger is invalid and described by the error while the error shows, and not before or after (%s)", async how => {
  await open(1440);
  const pick = selectTrigger(page, t("statutory.resolution"));
  const commit = page.getByRole("button", { name: t("statutory.preview"), exact: true });
  await element(pick).toHaveAccessibleName(`${t("statutory.pickResolution")} ${t("statutory.resolution")}`);
  await element(pick).not.toHaveAttribute("aria-invalid");
  await element(pick).toHaveAccessibleDescription("");

  if (how === "keyboard") await commit.press("Enter");
  else await commit.click();
  await element(page.getByText(t("statutory.requiredResolution"), { exact: true })).toBeVisible();
  await element(pick).toHaveAttribute("aria-invalid", "true");
  await element(pick).toHaveAccessibleDescription(t("statutory.requiredResolution"));
  // Each select answers for its own error only.
  await element(selectTrigger(page, t("statutory.lossCode"))).toHaveAccessibleDescription(t("statutory.requiredCode"));

  if (how === "keyboard") {
    await pick.press("Enter");
    await element(list().getByRole("option").first()).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    await pick.click();
    await list().getByRole("option", { name: t("statutory.complete"), exact: true }).click();
  }
  await element(list()).toHaveCount(0);
  await element(pick).toBeFocused();
  await element(pick).toHaveAccessibleName(`${t("statutory.complete")} ${t("statutory.resolution")}`);
  await element(pick).not.toHaveAttribute("aria-invalid");
  await element(pick).toHaveAccessibleDescription("");
  await element(selectTrigger(page, t("statutory.lossCode"))).toHaveAttribute("aria-invalid", "true");
});

test.each([360, 320])("at %i px wide the open list fits inside the screen and no option is cut off", async width => {
  await open(width);
  for (const [label, count] of [[t("statutory.resolution"), 3], [t("statutory.lossCode"), 4]] as const) {
    await selectTrigger(page, label).click();
    await element(list()).toBeVisible();
    const pop = list().locator("xpath=..");
    const options = await list().getByRole("option").all();
    expect(options).toHaveLength(count);
    // The trigger is narrower still, so the list takes its capped minimum: the screen less 12 px at each side.
    expect((await box(pop)).width).toBeCloseTo(width - 24, 1);
    // The text of an option is measured too: a line that only reaches into the option's padding is cut off as well.
    for (const part of [pop, ...options, ...await list().locator("span").all()]) {
      const { x, width: w } = await box(part);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(width);
      // Nothing inside runs past its own edge: long labels wrap, with or without a space to wrap at.
      expect(await part.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await element(list()).toHaveCount(0);
  }
});

test("on a desk the list keeps its width: the trigger's, and never under 440 / 1.2 px", async () => {
  await open(1440);
  const wide = selectTrigger(page, t("statutory.resolution"));
  await wide.click();
  await element(list()).toBeVisible();
  const asked = (await box(wide)).width;
  expect(asked).toBeGreaterThan(440 / 1.2);
  expect((await box(list().locator("xpath=.."))).width).toBeCloseTo(asked, 1);

  await open(1440, "filter");
  const narrow = selectTrigger(page, "Source");
  await narrow.click();
  await element(list()).toBeVisible();
  expect((await box(narrow)).width).toBeLessThan(440 / 1.2);
  expect((await box(list().locator("xpath=.."))).width).toBeCloseTo(440 / 1.2, 1);
});
