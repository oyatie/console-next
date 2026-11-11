// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { AxeBuilder } from "@axe-core/playwright";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/reauth-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "reauth-test", resolveId: id => id === "/reauth-test.js" ? "\0reauth-test" : undefined,
      load: id => id === "\0reauth-test" ? `
        import {createElement as h,useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {configure,session} from '@console/api'; import {loadCatalog} from '@console/i18n';
        import {registerDraft} from '/apps/web/src/lib/react/draft-owner.ts';
        import {consentDestination} from '/apps/web/src/lib/react/session.ts';
        import {IdleGuard} from '/apps/web/src/auth/IdleGuard.tsx';
        import '/apps/web/src/app.css';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createMemoryHistory,createRootRoute,createRoute,createRouter,RouterProvider} from '@tanstack/react-router';
        import {Login} from '/apps/web/src/auth/Login.tsx';
        import {SetupPasskey} from '/apps/web/src/auth/SetupPasskey.tsx';
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>null,create:async()=>null,autofill:async()=>false}});
        await loadCatalog('ko');
        session.set({access_token:'h.'+btoa(JSON.stringify({sub:'user',org:'tenant'}))+'.s',requires_passkey_setup:false});
        const search=new URLSearchParams(location.search);
        if(search.has('draft')) registerDraft('draft',{principal:session.principal,text:()=> '작성 중인 퇴직 경위'});
        if (!search.has('view')) session.expire(search.get('reason'));
        function Recovery() {
          const [signingIn,setSigningIn]=useState(false);
          window.returnToDraft=()=>setSigningIn(false);
          return h(IdleGuard,{signingIn,onCodeSignIn:()=>{window.destination=consentDestination();setSigningIn(true)}});
        }
        let view=h(Recovery);
        if(search.has('view')) {
          const setup=search.get('view')==='setup';
          session.set({access_token:'h.'+btoa(JSON.stringify({sub:'user',org:'tenant',enrollment:setup}))+'.s',requires_passkey_setup:setup,privacy_consent_accepted:true});
          const root=createRootRoute();
          const login=createRoute({getParentRoute:()=>root,path:'/login',validateSearch:()=>({code:true}),component:Login});
          const enroll=createRoute({getParentRoute:()=>root,path:'/setup-passkey',component:SetupPasskey});
          const router=createRouter({routeTree:root.addChildren([login,enroll]),history:createMemoryHistory({initialEntries:[setup?'/setup-passkey':'/login?code=true']})});
          await router.load(); view=h(RouterProvider,{router});
        }
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},view));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/reauth-test") return next();
        res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html lang="ko"><head><title>다시 로그인</title></head><body><div id="root"></div><script type="module" src="/reauth-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen(); browser = await chromium.launch(); page = await (await browser.newContext()).newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

for (const draft of [false, true]) {
  test.each(["session_idle_expired", "session_expired", "session_revoked", "session_signed_out_elsewhere", "session_passkey_reset", "session_deactivated", "unknown"])(`%s initially focuses a safe target (draft=${draft})`, async reason => {
    await page.goto(`${server.resolvedUrls!.local[0]}reauth-test?reason=${reason}${draft ? "&draft" : ""}`);
    const dialog = page.getByRole("dialog", { name: "다시 로그인" });
    await dialog.waitFor();
    await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    const expected = reason === "session_deactivated" && !draft ? "SPAN" : "BUTTON";
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe(expected);
    expect(await page.getByRole("button", { name: "저장하지 않고 로그아웃" }).evaluate(el => el === document.activeElement)).toBe(false);
    expect(await dialog.getByRole("button", { name: "코드로 로그인" }).count()).toBe(reason === "session_passkey_reset" ? 1 : 0);
  });
}

test("reset code action leaves the dialog without a logout request", async () => {
  let logouts = 0;
  await page.route("**/api/v1/auth/logout", route => { logouts++; return route.fulfill({ status: 204 }); });
  await page.goto(`${server.resolvedUrls!.local[0]}reauth-test?reason=session_passkey_reset&draft#report`);
  await page.getByRole("button", { name: "코드로 로그인" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { destination: string }).destination)).toBe("/reauth-test?reason=session_passkey_reset&draft#report");
  await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
  expect(logouts).toBe(0);
  await page.evaluate(() => (window as unknown as { returnToDraft: () => void }).returnToDraft());
  await page.getByRole("dialog", { name: "다시 로그인" }).waitFor();
  expect(await page.getByRole("button", { name: "코드로 로그인" }).count()).toBe(1);
});


test("code sign-in focuses the single code field", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}reauth-test?view=login`);
  // The app boots after the load event; wait for the field itself so a slow runner cannot outlast the poll.
  await page.getByLabel("일회용 코드").waitFor();
  await expect.poll(() => page.getByLabel("일회용 코드").evaluate(el => el === document.activeElement)).toBe(true);
  expect(await page.getByText("처음이면", { exact: false }).count()).toBe(0);
});

test.each(["reset", "login", "setup"])("%s recovery screen fits phone and desktop in both themes", async view => {
  await page.route("**/api/v1/onboarding/terms", route => route.fulfill({ json: { version: "terms", sha256: "hash", body: "서비스 이용약관", privacy: { version: "privacy", sha256: "hash", body: "개인정보 수집·이용", policy_url: "https://example.com/privacy", review_pending: false } } }));
  await page.goto(`${server.resolvedUrls!.local[0]}reauth-test?${view === "reset" ? "reason=session_passkey_reset&draft" : `view=${view}`}`);
  if (view === "reset") await page.getByRole("button", { name: "코드로 로그인" }).waitFor();
  if (view === "login") await page.getByLabel("일회용 코드").waitFor();
  if (view === "setup") await page.getByRole("button", { name: /동의하고 패스키 등록/, disabled: false }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, nextTheme) => { el.dataset.theme = nextTheme; }, theme);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
      await page.screenshot({ path: resolve(`.cache/reauth-test/${view}-${width}-${theme}.png`) });
    }
  }
});
