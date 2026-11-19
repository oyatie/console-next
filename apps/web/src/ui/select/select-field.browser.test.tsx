// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

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

const open = () => page.goto(`${server.resolvedUrls!.local[0]}select-test`);
/** The trigger of the select with this label; its name is the shown value and then the label. */
const trigger = (label: string) => page.getByRole("button", { name: new RegExp(` ${label}$`) });
const list = () => page.getByRole("listbox");

test.each(["keyboard", "pointer"])("the trigger is invalid and described by the error while the error shows, and not before or after (%s)", async how => {
  await open();
  const pick = trigger(t("statutory.resolution"));
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
  await element(trigger(t("statutory.lossCode"))).toHaveAccessibleDescription(t("statutory.requiredCode"));

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
  await element(trigger(t("statutory.lossCode"))).toHaveAttribute("aria-invalid", "true");
});
