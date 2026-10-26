// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { rrn } from "../../../../../../e2e/helpers/import-layouts";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
const secret = rrn("1990-01-01", 1, 9);
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/privacy-test", logLevel: "error", optimizeDeps: browserTestOptimizeDeps,
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "privacy-test", resolveId: (id) => id === "/privacy-test.js" ? "\0privacy-test" : undefined,
      load: (id) => id === "\0privacy-test" ? `
        import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {configure} from '@console/api';
        import {createMemoryHistory,createRootRoute,createRouter,RouterContextProvider} from '@tanstack/react-router';
        import {loadCatalog} from '@console/i18n'; import {RrnValue} from '/apps/web/src/features/people/ui/rrn-value.tsx';
        import {bindAnnouncer} from '/apps/web/src/lib/react/announce.ts';
        bindAnnouncer(text=>document.getElementById('privacy-status').textContent=text);
        import {FieldValue} from '/apps/web/src/features/people/ui/field-value.tsx';
        const fieldCode=new URLSearchParams(location.search).get('field');
        import '/apps/web/src/app.css';
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>({id:"proof"}),create:async()=>null}});
        await loadCatalog('ko');
        window.privacyClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
        const router=createRouter({routeTree:createRootRoute(),history:createMemoryHistory({initialEntries:['/']})});
        createRoot(document.getElementById('root')).render(createElement(QueryClientProvider,{client:window.privacyClient},
          createElement(RouterContextProvider,{router},createElement(fieldCode?FieldValue:RrnValue,{employeeId:'person',who:'한기록',masked:fieldCode?'가림':'••••••-•••••••',fieldCode,field:'생년월일',allowed:true}))));
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/privacy-test") return next();
        res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div><div role="status" id="privacy-status"></div><script type="module" src="/privacy-test.js"></script>');
      }); },
    }],
  });
  await server.listen(); browser = await chromium.launch(); page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });
beforeEach(async () => {
  await page.route("**/api/v1/auth/passkey/step-up/start", route => route.fulfill({ json: { ceremony_id: "ceremony", challenge: { publicKey: {} } } }));
  await page.route("**/api/v1/reason-codes?**", (route) => route.fulfill({ json: { items: [{ code: "REVIEW", system: false, label_ko: "업무 확인", active: true, requires_note: false }] } }));
  await page.goto(`${server.resolvedUrls!.local[0]}privacy-test`);
  await page.getByRole("button", { name: /주민등록번호 보기/ }).waitFor();
});
afterEach(async () => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

async function ask() {
  await page.getByRole("button", { name: /주민등록번호 보기/ }).click();
  await page.getByText("업무 확인", { exact: true }).click();
  await page.getByRole("button", { name: "보기", exact: true }).click();
}

test("reveal waits for the POST, uses the returned display duration, and remasks", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((done) => { release = done; });
  let request: unknown;
  await page.route("**/api/v1/employees/person/rrn/reveal", async (route) => {
    request = route.request().postDataJSON(); await held;
    await route.fulfill({ json: { employee_id: "person", rrn: secret, display_seconds: 15 } });
  });
  await page.clock.install();
  await ask();
  await expect.poll(() => request).toMatchObject({ reason_code: "REVIEW", step_up: { binding: { action_kind: "PII_REVEAL", object_id: "person" } } });
  expect(await page.getByText(secret, { exact: true }).count()).toBe(0);
  release();
  await page.getByRole("timer").waitFor();
  expect(await page.getByText(secret, { exact: true }).isVisible()).toBe(true);
  expect(await page.getByRole("timer").textContent()).toBe("15초");
  expect(await page.getByRole("status").textContent()).toContain("15초");
  await page.clock.fastForward(15_001);
  await page.getByRole("button", { name: /주민등록번호 보기/ }).waitFor();
  expect(await page.getByText(secret, { exact: true }).count()).toBe(0);
  expect(await page.getByRole("status").textContent()).toContain("다시 가렸습니다");
});

test.each([403, 429, 500])("a refused or failed reveal (%s) returns no value", async (status) => {
  await page.route("**/api/v1/employees/person/rrn/reveal", (route) => route.fulfill({ status, json: { error: { code: "request_failed", message: "" } } }));
  await ask();
  await expect.poll(async () => page.getByRole("dialog").getByRole("button", { name: "보기", exact: true }).isEnabled()).toBe(status < 500);
  expect(await page.getByText(secret, { exact: true }).count()).toBe(0);
  expect(await page.getByText("••••••-•••••••", { exact: true }).count()).toBe(1);
  expect(await page.getByRole("dialog").locator('[role="alert"], [role="status"]').innerText()).not.toBe("");
});

test("Escape masks a revealed value immediately", async () => {
  await page.route("**/api/v1/employees/person/rrn/reveal", (route) => route.fulfill({ json: { employee_id: "person", rrn: secret, display_seconds: 60 } }));
  await ask(); await page.getByRole("timer").waitFor();
  await page.keyboard.press("Escape");
  expect(await page.getByText(secret, { exact: true }).count()).toBe(0);
});


test("purpose is required before opening a field", async () => {
  await page.getByRole("button", { name: /주민등록번호 보기/ }).click();
  expect(await page.getByRole("dialog").getByRole("button", { name: "보기", exact: true }).isDisabled()).toBe(true);
});

test.each([0, -1, undefined])("invalid display duration (%s) explains failure without exposing a value", async (display_seconds) => {
  await page.route("**/api/v1/employees/person/rrn/reveal", (route) => route.fulfill({ json: { employee_id: "person", rrn: secret, display_seconds } }));
  await ask();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  expect(await page.getByText(secret, { exact: true }).count()).toBe(0);
});

test("reveal response is forgotten by the mutation and query caches", async () => {
  await page.route("**/api/v1/employees/person/rrn/reveal", (route) => route.fulfill({ json: { employee_id: "person", rrn: secret, display_seconds: 60 } }));
  await ask(); await page.getByRole("timer").waitFor();
  await expect.poll(() => page.evaluate(() => {
    const client = (window as unknown as { privacyClient: import("@tanstack/react-query").QueryClient }).privacyClient;
    return { mutations: client.getMutationCache().getAll().length, queries: JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data)) };
  })).toEqual({ mutations: 0, queries: expect.not.stringContaining(secret) });
});

test.each([1440, 390])("%spx reveal reserves its size and keeps the timer and hide button on one line", async (width) => {
  await page.setViewportSize({ width, height: 844 });
  await page.route("**/api/v1/employees/person/rrn/reveal", (route) => route.fulfill({ json: { employee_id: "person", rrn: secret, display_seconds: 60 } }));
  const value = page.locator("#root > span");
  const masked = await value.boundingBox();
  await ask(); await page.getByRole("timer").waitFor();
  const revealed = await value.boundingBox();
  expect({ width: revealed!.width, height: revealed!.height }).toEqual({ width: masked!.width, height: masked!.height });
  for (const item of [page.getByRole("timer"), page.getByRole("button", { name: "가리기" })]) {
    const lines = await item.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
    expect(lines).toBeLessThan(2);
  }
  await page.getByRole("button", { name: "가리기" }).click();
  const remasked = await value.boundingBox();
  expect({ width: remasked!.width, height: remasked!.height }).toEqual({ width: masked!.width, height: masked!.height });
});


test("failed passkey step-up never calls the reveal endpoint", async () => {
  let calls = 0;
  await page.route("**/api/v1/employees/person/rrn/reveal", route => { calls++; return route.fulfill({json:{rrn:secret,display_seconds:60}}); });
  await page.route("**/api/v1/auth/passkey/step-up/start", route => route.fulfill({status:401,json:{error:{code:"passkey_step_up_failed"}}}));
  await ask(); await page.getByRole("dialog").getByRole("alert").waitFor();
  expect(calls).toBe(0);
  expect(await page.getByText(secret,{exact:true}).count()).toBe(0);
});


test.each([
  ["BIRTH_DATE", "1965-01-01", "1965. 01. 01."],
  ["PHONE", "+821012345821", "010-1234-5821"],
  ["ADDRESS", { as_printed: "경기도 평택시 새온로 118 101호" }, "경기도 평택시 새온로 118 101호"],
  ["PERSONAL_EMAIL", "personal@example.com", "personal@example.com"],
])("%s displays only the generic POST response, formatted for its field", async (field, value, displayed) => {
  await page.goto(`${server.resolvedUrls!.local[0]}privacy-test?field=${field}`);
  let sent: unknown;
  let release: () => void = () => {};
  const held = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/employees/person/reveal", async route => {
    sent = route.request().postDataJSON(); await held;
    await route.fulfill({json:{employee_id:"person",field,value,display_seconds:15}});
  });
  await page.getByRole("button", {name:/생년월일 보기/}).click();
  await page.getByText("업무 확인",{exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"보기",exact:true}).click();
  await expect.poll(()=>sent).toMatchObject({field,reason_code:"REVIEW"});
  expect(await page.getByRole("dialog").textContent()).toContain("한기록 · 생년월일");
  expect(await page.getByRole("dialog").textContent()).not.toContain("주민등록번호");
  expect(await page.getByText(String(displayed),{exact:true}).count()).toBe(0);
  release(); await page.getByRole("timer").waitFor();
  expect(await page.getByText(String(displayed),{exact:true}).isVisible()).toBe(true);
});

test("a generic field's log failure explains the refusal and keeps the field masked", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}privacy-test?field=BIRTH_DATE`);
  await page.route("**/api/v1/employees/person/reveal", route=>route.fulfill({status:500,json:{error:{code:"internal"}}}));
  await page.getByRole("button", {name:/생년월일 보기/}).click();
  await page.getByText("업무 확인",{exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"보기",exact:true}).click();
  await page.getByRole("dialog").getByRole("status").waitFor();
  expect(await page.getByText("가림",{exact:true}).isVisible()).toBe(true);
  expect(await page.getByRole("timer").count()).toBe(0);
});
