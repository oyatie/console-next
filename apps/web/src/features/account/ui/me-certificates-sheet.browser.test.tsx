// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { expect as dom } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { chromium, browserTestOptimizeDeps, type Browser } from "../../../lib/browser-test";

const CERT = {
  id: "00000000-0000-4000-8900-000000000001", certificate_no: "CERT-2026-0001", kind: "EMPLOYMENT", items: ["position"],
  purpose: "Bank", issued_at: "2026-11-02T09:00:00+09:00", voided_at: null,
  snapshot: { name: "Test Person", position: "Lead", duty: null, period: null, birth: "1990-01-01", wage: null, issuer: "Test Co", seal_png: null },
};
let server: ViteDevServer;
let browser: Browser;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/me-certificates-sheet-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{
      name: "me-certificates-sheet-test",
      resolveId: id => id === "/sheet-test.js" ? "\0sheet-test" : undefined,
      // The sheet's open state comes from outside, as the address gives it: "Back" closes it without its own close.
      load: id => id === "\0sheet-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { configure } from '@console/api';
        import { loadCatalog } from '@console/i18n';
        import { MeCertificatesSheet } from '/apps/web/src/features/account/ui/me-certificates-sheet.tsx';
        await loadCatalog('ko');
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>null,create:async()=>null}});
        function Harness() {
          const [open, setOpen] = useState(true);
          return h('div', null, h('button', {id:'address-open', onClick:()=>setOpen(true)}, 'open'),
            h('button', {id:'address-back', onClick:()=>setOpen(false)}, 'back'),
            h(MeCertificatesSheet, {open, employmentStatus:'ACTIVE', onClose:()=>setOpen(false)}));
        }
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},h(Harness)));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/sheet-test") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><html lang="ko"><head><title>Certificates</title></head><body><div id="root"></div><script type="module" src="/sheet-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("a sheet closed by Back opens again on its list, not on the certificate it last showed", async () => {
  const page = await browser.newPage();
  await page.route("**/api/v1/me/certificates**", route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith(CERT.id) ? CERT : { items: [CERT], next_cursor: null } }));
  await page.goto(`${server.resolvedUrls!.local[0]}sheet-test`);
  const sheet = page.getByRole("dialog", { name: t("account.certificates.title") });
  await sheet.getByRole("button", { name: t("account.certificates.openPreview") }).click();
  await dom(sheet.getByText(t("empDoc.certificate.number", { number: CERT.certificate_no }))).toBeVisible();

  await page.locator("#address-back").evaluate((button: HTMLButtonElement) => button.click());
  await dom(sheet).toHaveCount(0);
  await page.locator("#address-open").evaluate((button: HTMLButtonElement) => button.click());
  await dom(sheet.getByRole("button", { name: t("account.certificates.openPreview") })).toBeVisible();
  await dom(sheet.getByRole("button", { name: t("account.certificates.backToList") })).toHaveCount(0);
  await page.close();
});
