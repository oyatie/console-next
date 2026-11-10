// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, test } from "vitest";
import { browserTestOptimizeDeps } from "../../../lib/browser-test";

let server: ViteDevServer, browser: Browser, page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/sole-holder-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "sole-holder-test", enforce: "pre",
      resolveId: id => id === "/sole-holder-test.js" ? "\0sole-holder-test" : undefined,
      load: id => id === "\0sole-holder-test" ? `
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { loadCatalog } from '@console/i18n';
        import Gallery from '/apps/web/src/features/org/ui/sole-holder-decision.gallery.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: new QueryClient() }, h(Gallery)));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/sole-holder-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Organization exception</title><div id="root"></div><script type="module" src="/sole-holder-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("the exception sheet returns keyboard focus to its opener without a write", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}sole-holder-test`);
  const opener = page.getByRole("button", { name: t("orgChange.sole.open"), exact: true });
  await opener.focus();
  await opener.press("Enter");
  const dialog = page.getByRole("dialog", { name: t("orgChange.sole.open"), exact: true });
  await browserExpect(dialog).toBeVisible();
  await browserExpect(dialog).toContainText(t("uiOverrideSheet.sole.notify", { count: 2 }));
  await page.keyboard.press("Escape");
  await browserExpect(dialog).toHaveCount(0);
  await browserExpect(opener).toBeFocused();
  await browserExpect(page.getByText(t("uiOverrideSheet.mark"), { exact: true })).toBeVisible();
});
