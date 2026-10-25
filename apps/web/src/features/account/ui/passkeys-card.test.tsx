// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { PasskeysCard } from "./passkeys-card";

type Passkey = components["schemas"]["PasskeySummary"];
const key: Passkey = { id: "01980b10-0000-7000-8000-000000000001", label: "보안키", created_at: "2026-10-25T00:00:00Z", last_used_at: null };
let server: ViteDevServer;
let browser: Browser;
let page: Page;

function renderKeys(keys: Passkey[]) {
  const client = new QueryClient();
  const passkeys = { data: keys, isPending: false, error: null } as UseQueryResult<Passkey[]>;
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PasskeysCard ops={false} passkeys={passkeys} /></QueryClientProvider>);
  client.clear();
  return html;
}

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/passkeys-card-test", logLevel: "error",
    optimizeDeps: { include: ["react", "react/jsx-dev-runtime", "react-dom/client", "@tanstack/react-query", "@tanstack/react-router", "intl-messageformat", "lucide-react", "react-aria-components", "openapi-fetch"] },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "passkeys-card-test",
      resolveId: id => id === "/passkeys-test.js" ? "\0passkeys-test" : undefined,
      load: id => id === "\0passkeys-test" ? `
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
        import { configure } from '@console/api';
        import { loadCatalog } from '@console/i18n';
        import { passkeysQuery } from '/apps/web/src/features/account/api.ts';
        import { PasskeysCard } from '/apps/web/src/features/account/ui/passkeys-card.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        configure({baseUrl:location.origin,refresh:{kind:'cookie'},passkeys:{get:async()=>({id:'asserted-key'}),create:async()=>({id:'created-key'})}});
        function Demo() {
          const passkeys = useQuery(passkeysQuery);
          return h('main', null, h('h1',null,'내 계정'), h(PasskeysCard,{ops:false,passkeys}));
        }
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:new QueryClient()},h(Demo)));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/passkeys-test") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>계정</title></head><body><div id="root"></div><script type="module" src="/passkeys-test.js"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10000);
  await page.route("**/api/v1/auth/passkeys/policy", route => route.fulfill({ json: { label_max_length: 12 } }));
}, 60_000);

test("registration asks for an optional name and submits its supplied or default label", async () => {
  const stored = [{ ...key }];
  const labels: string[] = [];
  await page.route("**/api/v1/auth/passkeys", route => route.fulfill({ json: stored }));
  await page.route("**/api/v1/auth/passkey/**", route => {
    if (!route.request().url().endsWith("/register/finish")) {
      return route.fulfill({ json: { ceremony_id: key.id, challenge: { publicKey: {} } } });
    }
    const body = route.request().postDataJSON();
    labels.push(body.label);
    stored.push({ ...key, id: `01980b10-0000-7000-8000-00000000000${stored.length + 1}`, label: body.label });
    return route.fulfill({ json: { passkey_id: stored.at(-1)!.id, user_id: key.id, credential_id: "created-key", sign_in_id: "member@example" } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}passkeys-test`);
  await page.getByRole("table").waitFor();
  for (const [input, expected] of [["개인 키", "개인 키"], ["", "패스키 3"]]) {
    await page.getByRole("button", { name: "패스키 등록", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const name = dialog.getByLabel("패스키 이름");
    expect(await name.getAttribute("required")).toBeNull();
    await name.fill(input!);
    await dialog.getByRole("button", { name: "패스키 등록", exact: true }).click();
    await page.getByRole("button", { name: `${expected} 이름 변경`, exact: true }).waitFor();
  }
  expect(labels).toEqual(["개인 키", "패스키 3"]);
}, 30_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("one registration control and no deletion control for the last passkey", () => {
  const html = renderKeys([key]);
  expect(html.match(/패스키 등록/g)).toHaveLength(1);
  expect(html).not.toContain("삭제</button>");
});

test("custom labels and numbered defaults name passkeys", () => {
  const html = renderKeys([key, { ...key, id: "01980b10-0000-7000-8000-000000000002", label: null }]);
  expect(html).toContain("보안키");
  expect(html).toContain("패스키 2");
  expect(html).toContain('aria-label="보안키 삭제"');
});

test("rename roundtrip refreshes the row and the naming dialog passes axe", async () => {
  let stored = { ...key };
  let writes = 0;
  await page.route("**/api/v1/auth/passkeys", route => route.fulfill({ json: [stored] }));
  await page.route("**/api/v1/auth/passkeys/*", route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    writes++;
    stored = { ...stored, label: route.request().postDataJSON().label };
    return route.fulfill({ json: stored });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}passkeys-test`);
  await page.getByRole("table").waitFor();
  const rename = page.getByRole("button", { name: "보안키 이름 변경", exact: true });
  expect(await rename.count()).toBe(1);
  await rename.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("패스키 이름").fill("개인 보안키");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    }
  }
  await dialog.getByRole("button", { name: "이름 변경", exact: true }).click();
  await page.getByRole("button", { name: "개인 보안키 이름 변경", exact: true }).waitFor();
  expect(writes).toBe(1);
  expect(stored.label).toBe("개인 보안키");
  expect(await page.getByRole("dialog").count()).toBe(0);
  await page.reload();
  await page.getByRole("button", { name: "개인 보안키 이름 변경", exact: true }).waitFor();
}, 60_000);

test("an invalid name keeps the edit and explains the server refusal in Korean", async () => {
  await page.route("**/api/v1/auth/passkeys", route => route.fulfill({ json: [key] }));
  await page.route(`**/api/v1/auth/passkeys/${key.id}`, route => route.fulfill({ status: 422, json: { error: { code: "passkey_label_invalid", message: "invalid passkey label" } } }));
  await page.goto(`${server.resolvedUrls!.local[0]}passkeys-test`);
  await page.getByRole("button", { name: "보안키 이름 변경", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const invalid = "허용할 이름";
  await dialog.getByLabel("패스키 이름").fill(invalid);
  await dialog.getByRole("button", { name: "이름 변경", exact: true }).click();
  await page.getByRole("alert").waitFor();
  expect(await page.getByRole("alert").innerText()).toContain("패스키 이름의 길이와 제어문자를 확인하십시오.");
  expect(await dialog.getByLabel("패스키 이름").inputValue()).toBe(invalid);
});


test("the naming field reads the server limit and invalid names never start registration", async () => {
  let starts = 0;
  await page.route("**/api/v1/auth/passkeys", route => route.fulfill({ json: [key] }));
  await page.route("**/api/v1/auth/passkey/register/start", route => { starts++; return route.fulfill({ status: 422, json: { error: { code: "passkey_label_invalid", message: "invalid label" } } }); });
  await page.goto(`${server.resolvedUrls!.local[0]}passkeys-test`);
  await page.getByRole("button", { name: "패스키 등록", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByLabel("패스키 이름");
  await field.waitFor();
  await expect.poll(() => field.getAttribute("maxlength")).toBe("12");
  await field.fill("가".repeat(13));
  expect(await field.inputValue()).toBe("가".repeat(12));
  await field.fill("개인\u007f키");
  expect(await dialog.getByRole("button", { name: "패스키 등록", exact: true }).isDisabled()).toBe(true);
  expect(starts).toBe(0);
});
