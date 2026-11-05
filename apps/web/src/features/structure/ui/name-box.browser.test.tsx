// SPDX-License-Identifier: LicenseRef-Proprietary
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/name-box-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "name-box-test", resolveId: id => id === "/name-box-test.js" ? "\0name-box-test" : undefined,
      load: id => id === "\0name-box-test" ? `
        import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
        import {NameBox} from '/apps/web/src/features/structure/ui/name-box.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function Fixture() {
          const [pending,setPending]=useState(false), [saved,setSaved]=useState(''), [batch,setBatch]=useState(0), [sent,setSent]=useState(''), [sends,setSends]=useState(0);
          const parent={id:'site',kind:'site',name:'본사',headcount:0,chips:[],depth:2,children:saved?[{id:'dept',kind:'dept',name:saved,children:[]}]:[]};
          return React.createElement(React.Fragment,null,
            React.createElement(NameBox,{key:batch,parent,box:{x:20,y:100,w:224,h:108},pending,
              onSubmit:name=>{setSent(name);setSends(n=>n+1);setPending(true)},onCancel:()=>{}}),
            React.createElement('output',{'aria-label':'Send count'},sends),
            React.createElement('button',{onClick:()=>setSaved(sent)},'Refresh tree'),
            React.createElement('button',{onClick:()=>{setBatch(batch+1);setPending(false)}},'Finish save'),
            React.createElement('button',{onClick:()=>setPending(false)},'Refuse save'));
        }
        const client=new QueryClient({defaultOptions:{queries:{retry:false,queryFn:async()=>({items:[]})}}});
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(Fixture)));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/name-box-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Department editor</title><div id="root"></div><script type="module" src="/name-box-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await page?.close(); await browser?.close(); await server?.close(); });

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`saved name never becomes a duplicate during refresh at ${width}px in ${theme}`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}name-box-test`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const field = page.getByRole("textbox", { name: "본사 아래 새 부서 이름" });
    await field.fill("개발팀");
    await field.press("Enter");
    await expect(field).toHaveAttribute("readonly", "");
    await field.press("Enter");
    await expect(page.getByRole("status", { name: "Send count" })).toHaveText("1");
    await page.getByRole("button", { name: "Refresh tree" }).click();
    await expect(field).toHaveValue("개발팀");
    await expect(field).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Finish save" }).click();
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await field.fill("개발팀");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toHaveText("같은 곳에 개발팀이 이미 있습니다");
    await field.fill("인사팀");
    await page.getByRole("button", { name: "부서 추가", exact: true }).click();
    await page.getByRole("button", { name: "Refuse save" }).click();
    await expect(field).not.toHaveAttribute("readonly");
    await expect(field).toHaveValue("인사팀");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
