// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, selectTrigger, type Browser, type Page } from "../../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("./filing-request.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/filing-request-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/statutory/ui/filing-request.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/filing-request-test", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Filing request test</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const kind = () => selectTrigger(page, t("statutory.requestKind"));
const date = () => page.getByRole("textbox", { name: t("statutory.requestOn") });
/** Opens the dialog afresh and commits the form after `fill`; the two are never both given, so nothing is sent. */
const commit = async (fill: () => Promise<void>) => {
  await page.goto(`${server.resolvedUrls!.local[0]}filing-request-test`);
  await element(kind()).not.toHaveAttribute("aria-invalid");
  await element(date()).not.toHaveAttribute("aria-invalid");
  await fill();
  await page.getByRole("button", { name: t("statutory.requestSave"), exact: true }).click();
};

test("with a date and no filing kind, the kind select is the invalid control and the date field is not", async () => {
  await commit(async () => {
    await date().fill("2026-11-19");
    await date().press("Tab");
  });
  await element(kind()).toHaveAttribute("aria-invalid", "true");
  await element(kind()).toHaveAccessibleDescription("신고 종류를 선택하십시오.");
  await element(date()).not.toHaveAttribute("aria-invalid");
  await element(date()).toHaveAccessibleDescription("");
});

test("with a filing kind and no date, the date field is the invalid control and the kind select is not", async () => {
  await commit(async () => {
    await kind().click();
    await page.getByRole("option").first().click();
  });
  await element(date()).toHaveAttribute("aria-invalid", "true");
  await element(date()).toHaveAccessibleDescription("요청일 또는 근로월 말일을 선택하십시오.");
  await element(kind()).not.toHaveAttribute("aria-invalid");
  await element(kind()).toHaveAccessibleDescription("");
});

test("with neither, each control is invalid and described by its own message", async () => {
  await commit(async () => {});
  for (const [control, message] of [[kind(), "신고 종류를 선택하십시오."], [date(), "요청일 또는 근로월 말일을 선택하십시오."]] as const) {
    await element(control).toHaveAttribute("aria-invalid", "true");
    await element(control).toHaveAccessibleDescription(message);
  }
});
