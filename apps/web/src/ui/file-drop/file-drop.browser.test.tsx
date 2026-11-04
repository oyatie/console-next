// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/file-drop-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "file-drop-test",
      resolveId: id => id === "/file-drop-test.js" ? "\0file-drop-test" : undefined,
      load: id => id === "\0file-drop-test" ? `
        import {createElement as h, useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import {FileDrop} from '/apps/web/src/ui/file-drop/file-drop.tsx';
        await loadCatalog('ko');
        function Demo() {
          const [name,setName]=useState('');
          return h('main',null,h(FileDrop,{label:'Roster',accept:[{mime:'text/csv',ext:'.csv'}],maxBytes:1024,onFiles:([file])=>setName(file.name)}),h('output',null,name));
        }
        createRoot(document.getElementById('root')).render(h(Demo));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/file-drop-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<div id="root"></div><script type="module" src="/file-drop-test.js"></script>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each(["application/octet-stream", "application/vnd.ms-excel"])("a CSV with OS MIME %s is accepted by its extension", async mimeType => {
  await page.goto(`${server.resolvedUrls!.local[0]}file-drop-test`);
  const choose = async (name: string, buffer: Buffer) => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "파일 선택", exact: true }).click();
    await (await chooser).setFiles({ name, mimeType, buffer });
  };
  await choose("roster.CSV", Buffer.from("001,가나다"));
  await expect.poll(() => page.locator("output").textContent()).toBe("roster.CSV");
  await choose("roster.CSV", Buffer.alloc(1025));
  await page.getByRole("alert").waitFor();
  expect(await page.getByRole("alert").textContent()).toContain("보다 큽니다");
  await choose("roster.exe", Buffer.from("001,가나다"));
  await expect.poll(() => page.getByRole("alert").textContent()).toContain("받을 수 있는 형식");
});
