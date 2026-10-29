// SPDX-License-Identifier: LicenseRef-Proprietary
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { createServer } from "vite";
import { browserTestOptimizeDeps, chromium } from "../lib/browser-test";
import { checklist as operatingChecklist, token, user } from "../../../../e2e/mock/fixtures";
import { recordShifts } from "../../../../e2e/stability";
import type { components } from "@console/api";

export const navModules = (phase: string): components["schemas"]["OnboardingModules"] => [
  ...(["home", "org", "access", "people"] as const).map(key => ({ key, ready: true, unblock: null })),
  ...(["attendance", "statutory", "exits"] as const).map(key => ({ key, ready: phase === "OPERATING", unblock: phase === "OPERATING" ? null : "open_go_live_preview" as const })),
];

declare global {
  interface Window { __refetchChecklist: () => Promise<void>; refetchNavModules: () => Promise<void>; refetchNavDecisions: () => Promise<void>; switchNavPrincipal: () => void; __navFacts: { phase?: string; state?: string } }
}

export async function navFixture(engine = chromium) {
  const errors: string[] = [];
  const server = await createServer({ configFile: false, cacheDir: ".cache/nav-shell-test", logLevel: "error", define: { "process.env.VIRT_ON": "true" },
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "nav-shell-test", resolveId: id => id === "/nav-shell-test.js" ? "\0nav-shell-test" : undefined,
      load: id => id === "\0nav-shell-test" ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
        import {createRootRoute,createRoute,createRouter,RouterProvider,Link} from '@tanstack/react-router';
        import {configure,refresh,session} from '@console/api'; import {webPlatform} from '@console/api/web';
        import {loadCatalog} from '@console/i18n';
        import {Shell} from '/apps/web/src/shell/shell.tsx';
        import {GoLive} from '/apps/web/src/features/onboarding/ui/go-live.tsx';
        import {meQuery} from '/apps/web/src/features/account/api.ts';
        import {checklistQuery,SETUP_READS,skipStep} from '/apps/web/src/features/onboarding/api.ts';
        import {useCommand} from '/apps/web/src/lib/react/command.ts';
        import {invalidateWhere,navigationRead,queryPath} from '/apps/web/src/lib/query.ts';
        import '/apps/web/src/app.css';
        configure({...webPlatform,passkeys:{get:async()=>({id:'test-passkey'}),create:async()=>null}}); await refresh(); await loadCatalog('ko');
        const root=createRootRoute({component:Shell});
        const paths=['/','/people','/people/exits','/people/period-locks','/people/requests','/org','/org/entities','/org/history','/access','/attendance','/statutory','/settings'];
        function Fixture(){
          useQuery(checklistQuery);
          const me=useQuery(navigationRead(meQuery));
          window.__navFacts={phase:me.data?.tenant?.phase};
          const complete=useCommand({run:()=>skipStep('org'),invalidates:SETUP_READS});
          return React.createElement(React.Fragment,null,React.createElement('h1',null,'Setup'),React.createElement(Link,{to:'/setup/go-live'},'Start operations'),React.createElement(Link,{to:'/people/period-locks'},'Period locks'),React.createElement('button',{onClick:()=>complete.mutate()},'Complete setup'));
        }
        const routes=paths.map(path=>createRoute({getParentRoute:()=>root,path,staticData:{access:'signed-in'},component:Fixture}));
        const router=createRouter({routeTree:root.addChildren([...routes,createRoute({getParentRoute:()=>root,path:'/setup/go-live',staticData:{access:'signed-in'},component:GoLive})])});
        const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
        window.switchNavPrincipal=()=>{
          session.set({access_token:'h.'+btoa(JSON.stringify({...session.claims,sub:'other-principal',name:'Test operator'}))+'.s',token_type:'Bearer',refresh_expires_at:'2099-01-01T00:00:00Z',requires_passkey_setup:false,privacy_consent_accepted:true});
          void router.navigate({to:'/org'});
        };
        window.__refetchChecklist=async()=>{await invalidateWhere(client,path=>path===queryPath(checklistQuery));};
        window.refetchNavModules=async()=>{await invalidateWhere(client,path=>path==='/api/v1/onboarding/modules');};
        window.refetchNavDecisions=async()=>{await invalidateWhere(client,path=>path==='/api/v1/access/me'||path==='/api/v1/support-sessions/active');};
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(RouterProvider,{router})));
      ` : undefined }],
  });
  await server.listen();
  const browser = await engine.launch();
  const page = await browser.newPage();
  await page.addInitScript(recordShifts);
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => url.pathname.startsWith("/api/"), route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/onboarding/modules") return route.fulfill({ json: navModules(user.tenant!.phase) });
    const json = path.endsWith("/token/refresh") ? token() : path === "/api/v1/users/me" ? user :
      path === "/api/v1/onboarding/checklist" ? operatingChecklist :
      path === "/api/v1/access/me" ? { is_ops: true, entries: [] } :
      path === "/api/v1/me/authz" ? { capabilities: [] } :
      path === "/api/v1/support-sessions/active" ? { sessions: [], pending_count: 0, pending_approvals: [], can_approve: false } : {};
    return route.fulfill({ json });
  });
  await page.route(url => !url.pathname.includes(".") && !url.pathname.startsWith("/@") && !url.pathname.startsWith("/api/"), route =>
    route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Navigation</title><div id="root"></div><script type="module" src="/nav-shell-test.js"></script></html>' }));
  return { server, browser, page, errors };
}
