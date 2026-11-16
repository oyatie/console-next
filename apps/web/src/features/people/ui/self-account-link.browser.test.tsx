// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium } from "../../../lib/browser-test";

let server: ViteDevServer, browser: Browser, page: Page, reviewPage: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/self-account-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{ name: "self-account-test", enforce: "pre",
      resolveId: id => id === "/self-account-test.js" ? "\0self-account-test" : undefined,
      load: id => id === "\0self-account-test" ? `
        import {createElement as h} from 'react';
        import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {configure} from '@console/api';
        import {webPlatform} from '@console/api/web';
        import {loadCatalog} from '@console/i18n';
        import Gallery from '/apps/web/src/features/people/ui/self-account-link.gallery.tsx';
        import ReviewGallery from '/apps/web/src/features/people/ui/self-binding-review.gallery.tsx';
        import '/apps/web/src/app.css';
        configure(webPlatform); await loadCatalog('ko');
        createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:new QueryClient()},h(new URL(location.href).searchParams.has("review") ? ReviewGallery : Gallery)));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/self-account-test") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<html lang="ko"><title>Account link</title><div id="root"></div><script type="module" src="/self-account-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen(); browser = await chromium.launch();
  [page, reviewPage] = await Promise.all([browser.newPage(), browser.newPage()]);
}, 10_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("the own-account gallery action supports keyboard confirmation and stays pending for one write", async () => {
  const binding = { action_kind: "EXCEPTION_DECIDE", object_id: "00000000-0000-4000-8000-000000000002",
    reason_key: "passkey_step_up_exception_decide", replay_attempt: null, payload_hash: "a".repeat(64) };
  await page.route("**/api/v1/users/me/employee-link/prepare", route => route.fulfill({ json: binding }));
  await page.route("**/api/v1/auth/passkey/step-up/start", route => route.fulfill({ json: { binding,
    ceremony_id: "00000000-0000-4000-8000-000000000003", expires_at: "2099-01-01T00:00:00Z",
    challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } },
  } }));
  await page.route("**/api/v1/auth/passkey/login/start", route => route.fulfill({ json: {
    ceremony_id: "00000000-0000-4000-8000-000000000004", expires_at: "2099-01-01T00:00:00Z",
    challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } },
  } }));
  await page.addInitScript(() => Object.defineProperty(navigator.credentials, "get", {
    value: async () => ({ toJSON: () => ({ id: "test-passkey", type: "public-key" }) }),
  }));
  let release!: () => void, writes = 0, linked = false;
  const held = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/users/me/employee-link", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { attestation: linked ? { attestation_id: "00000000-0000-4000-8000-000000000003", employee_id: "00000000-0000-4000-8000-000000000001", can_withdraw: true } : null } });
    browserExpect(route.request().postDataJSON().confirmed_name).toBe("김하나");
    writes++; await held; linked = true;
    await route.fulfill({ status: 201, json: { attestation_id: "00000000-0000-4000-8000-000000000003" } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}self-account-test`);
  const button = page.getByRole("button", { name: "패스키로 확인하고 내 계정 연결", exact: true });
  await browserExpect(button).toBeDisabled();
  const name = page.getByRole("textbox");
  await name.fill("다른 이름");
  await browserExpect(button).toBeDisabled();
  await name.fill("김하나");
  await button.focus(); await button.press("Enter");
  await browserExpect(button).toBeDisabled();
  await browserExpect.poll(() => writes).toBe(1);
  release();
  await browserExpect(button).toHaveCount(0);
  const withdraw = page.getByRole("button", { name: "패스키로 확인하고 내 계정 연결 철회", exact: true });
  await browserExpect(withdraw).toBeVisible();
  let releaseWithdrawal!: () => void;
  const withdrawing = new Promise<void>(done => { releaseWithdrawal = done; });
  await page.route("**/api/v1/users/me/employee-link/withdraw", async route => {
    await withdrawing; linked = false;
    await route.fulfill({ json: {} });
  });
  await withdraw.click();
  await browserExpect(withdraw).toBeDisabled();
  releaseWithdrawal();
  await browserExpect(button).toBeVisible();
});

test("a pending keyboard review disables both decisions until the write finishes", async () => {
  await reviewPage.route("**/api/v1/auth/passkey/login/start", route => route.fulfill({ json: {
    ceremony_id: "00000000-0000-4000-8000-000000000002", expires_at: "2099-01-01T00:00:00Z",
    challenge: { publicKey: { challenge: "dGVzdA", rpId: "localhost" } },
  } }));
  await reviewPage.addInitScript(() => Object.defineProperty(navigator.credentials, "get", {
    value: async () => ({ toJSON: () => ({ id: "test-passkey", type: "public-key" }) }),
  }));
  let release!: () => void, writes = 0;
  const held = new Promise<void>(done => { release = done; });
  await reviewPage.route("**/api/v1/users/employee-link-attestations/*/review", async route => {
    browserExpect(route.request().postDataJSON().decision).toBe("CONFIRM");
    writes++; await held; await route.fulfill({ json: {} });
  });
  try {
    await reviewPage.goto(`${server.resolvedUrls!.local[0]}self-account-test?review=1`);
    const confirm = reviewPage.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.confirmBinding") }), exact: true });
    const revoke = reviewPage.getByRole("button", { name: t("uiOverrideSheet.stepUp", { action: t("people.account.revokeBinding") }), exact: true });
    await confirm.focus(); await confirm.press("Enter");
    await browserExpect(confirm).toBeDisabled(); await browserExpect(revoke).toBeDisabled();
    await browserExpect.poll(() => writes).toBe(1);
    release(); await browserExpect(confirm).toBeEnabled(); await browserExpect(revoke).toBeEnabled();
  } finally { release(); }
});
