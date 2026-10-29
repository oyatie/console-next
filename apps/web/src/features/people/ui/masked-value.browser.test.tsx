// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { AxeBuilder } from "@axe-core/playwright";
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
        import {RrnEntry} from '/apps/web/src/features/people/ui/rrn-entry.tsx';
        import {maskedBirth} from '/apps/web/src/features/people/domain/card.ts';
        import {RrnCard} from '/apps/web/src/features/identifiers/ui/rrn-card.tsx';
        const fieldCode=new URLSearchParams(location.search).get('field');
        const entry=new URLSearchParams(location.search).has('entry');
        const card=new URLSearchParams(location.search).has('card');
        import '/apps/web/src/app.css';
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>({id:"proof"}),create:async()=>null}});
        await loadCatalog('ko');
        window.privacyClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
        const router=createRouter({routeTree:createRootRoute(),history:createMemoryHistory({initialEntries:['/']})});
        createRoot(document.getElementById('root')).render(createElement(QueryClientProvider,{client:window.privacyClient},
          createElement(RouterContextProvider,{router},createElement(card?RrnCard:entry?RrnEntry:fieldCode?FieldValue:RrnValue,{employeeId:'person',employeeStatus:'ACTIVE',who:'한기록',masked:fieldCode==='BIRTH_DATE'?maskedBirth():fieldCode?'가림':'••••••-•••••••',fieldCode,field:'생년월일',allowed:true}))));
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/privacy-test") return next();
        res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html lang="ko"><head><title>개인정보</title></head><body><div id="root"></div><div role="status" id="privacy-status"></div><script type="module" src="/privacy-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen(); browser = await chromium.launch(); page = await (await browser.newContext()).newPage();
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
  expect(await page.getByText("••••-••-••",{exact:true}).isVisible()).toBe(true);
  expect(await page.getByRole("timer").count()).toBe(0);
});

async function enterNumber() {
  await page.goto(`${server.resolvedUrls!.local[0]}privacy-test?entry`);
  await page.getByRole("button", { name: "기록", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "주민등록번호 기록" });
  await sheet.getByRole("textbox", { name: /^주민등록번호/ }).fill(secret);
  return sheet;
}

test("record binds only the employee id, clears the input before passkey, and retains no number in caches", async () => {
  let binding: unknown;
  let sent: Record<string, unknown> | undefined;
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/auth/passkey/step-up/start", async route => {
    binding = route.request().postDataJSON().binding;
    await held;
    await route.fulfill({ json: { ceremony_id: "ceremony", challenge: { publicKey: {} } } });
  });
  await page.route("**/api/v1/employees/person/rrn", route => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { employee_id: "person", recorded: true, masked: "••••••-•••••••", source: "FORM" } });
  });
  const sheet = await enterNumber();
  await sheet.getByRole("button", { name: "기록", exact: true }).click();
  await expect.poll(() => binding).toMatchObject({ action_kind: "PII_RECORD", object_id: "person" });
  const expected = await page.evaluate(async () => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("person")))].map(b => b.toString(16).padStart(2, "0")).join(""));
  expect(binding).toMatchObject({ payload_hash: expected });
  expect(await sheet.getByRole("textbox", { name: /^주민등록번호/ }).inputValue()).toBe("");
  release();
  await sheet.waitFor({ state: "detached" });
  expect(sent?.rrn === secret.replace(/\D/g, "")).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const client = (window as unknown as { privacyClient: import("@tanstack/react-query").QueryClient }).privacyClient;
    return { mutations: client.getMutationCache().getAll().length, queries: JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data)) };
  })).toEqual({ mutations: 0, queries: expect.not.stringContaining(secret.replace(/\D/g, "")) });
});

test.each([
  [401, "step_up_required", "패스키로 본인임을 확인"],
  [401, "passkey_step_up_failed", "본인 확인에 실패"],
  [403, "forbidden", "권한"],
  [409, "rrn_already_recorded", "이미 기록된 번호"],
  [409, "rrn_in_use", "이 번호는 이미 기록"],
  [422, "rrn_invalid", "번호를 확인"],
  [429, "rrn_record_rate_limited", "기록 한도"],
  [503, "rrn_vault_unavailable", "암호화 키"],
])("record refusal %s %s clears the number and explains recovery", async (status, code, copy) => {
  await page.route("**/api/v1/employees/person/rrn", route => route.fulfill({ status: Number(status), json: { error: { code, message: code === "forbidden" ? "권한이 없습니다." : "요청을 처리하지 못했습니다." } } }));
  const sheet = await enterNumber();
  await sheet.getByRole("button", { name: "기록", exact: true }).click();
  await expect.poll(() => sheet.textContent()).toContain(copy);
  expect(await sheet.getByRole("textbox", { name: /^주민등록번호/ }).inputValue()).toBe("");
  expect(await page.getByText(secret, { exact: true }).count()).toBe(0);
});

test("closing a record sheet destroys its input", async () => {
  const sheet = await enterNumber();
  await sheet.getByRole("button", { name: "닫기", exact: true }).last().click();
  await page.getByRole("button", { name: "기록", exact: true }).click();
  expect(await sheet.getByRole("textbox", { name: /^주민등록번호/ }).inputValue()).toBe("");
  expect(await sheet.getByRole("button", { name: "기록", exact: true }).isDisabled()).toBe(true);
});

test("a refused record step-up never sends the number", async () => {
  let calls = 0;
  await page.route("**/api/v1/auth/passkey/step-up/start", route => route.fulfill({ status: 401, json: { error: { code: "passkey_step_up_failed" } } }));
  await page.route("**/api/v1/employees/person/rrn", route => { calls++; return route.abort(); });
  const sheet = await enterNumber();
  await sheet.getByRole("button", { name: "기록", exact: true }).click();
  await expect.poll(() => sheet.textContent()).toContain("본인 확인에 실패");
  expect(calls).toBe(0);
  expect(await sheet.getByRole("textbox", { name: /^주민등록번호/ }).inputValue()).toBe("");
});

test.each([1440, 390])("%spx record sheet is accessible in both themes and fits its viewport", async width => {
  await page.setViewportSize({ width, height: 844 });
  await enterNumber();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, chosen) => { el.dataset.theme = chosen; }, theme);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("masked reveal keeps 보기 next to its value, before the reserved timer space", async () => {
  const mask = await page.getByText("••••••-•••••••", { exact: true }).boundingBox();
  const show = await page.getByRole("button", { name: /주민등록번호 보기/ }).boundingBox();
  expect(show!.x - (mask!.x + mask!.width)).toBeLessThan(16);
});

test("390px birth-date mask stays whole in a narrow card cell", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.resolvedUrls!.local[0]}privacy-test?field=BIRTH_DATE`);
  await page.locator("#root").evaluate(el => { el.style.width = "70px"; });
  const mask = page.getByText("••••-••-••", { exact: true });
  await mask.waitFor();
  const lines = await mask.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  expect(lines).toBeLessThan(2);
});

test("identifiers records through the shared sheet and refreshes its masked status", async () => {
  let recorded = false;
  await page.route("**/api/v1/employees/person/rrn", route => {
    const writing = route.request().method() === "PUT";
    if (writing) recorded = true;
    return route.fulfill({ status: writing ? 201 : 200, json: {
      employee_id: "person", recorded, can_record: !recorded, masked: recorded ? "••••••-•••••••" : null, source: recorded ? "FORM" : null,
    } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}privacy-test?card`);
  await page.getByText("기록 없음").waitFor();
  await page.getByRole("button", { name: "기록", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "주민등록번호 기록" });
  await sheet.getByRole("textbox", { name: /^주민등록번호/ }).fill(secret);
  await sheet.getByRole("button", { name: "기록", exact: true }).click();
  await page.getByText("••••••-•••••••", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "기록", exact: true }).count()).toBe(0);
  expect(await page.getByRole("dialog").count()).toBe(0);
});

test.each([1440, 390])("%spx identifiers keeps the empty state and first-entry action on one field row", async width => {
  await page.setViewportSize({ width, height: 844 });
  await page.route("**/api/v1/employees/person/rrn", route => route.fulfill({ json: { employee_id: "person", recorded: false, can_record: true, masked: null } }));
  await page.goto(`${server.resolvedUrls!.local[0]}privacy-test?card`);
  const empty = page.getByText("기록 없음", { exact: true });
  const action = page.getByRole("button", { name: "기록", exact: true });
  await action.waitFor();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, chosen) => { el.dataset.theme = chosen; }, theme);
    await action.focus();
    const stateBox = await empty.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const box = range.getBoundingClientRect(); return { y: box.y, height: box.height }; }), actionBox = await action.boundingBox();
    expect(actionBox!.y).toBeLessThan(stateBox!.y + stateBox!.height);
    expect(stateBox!.y).toBeLessThan(actionBox!.y + actionBox!.height);
    expect(actionBox!.width).toBeLessThan(100);
    expect(await page.locator("#root").innerText()).not.toContain("기록 없음 ·");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
