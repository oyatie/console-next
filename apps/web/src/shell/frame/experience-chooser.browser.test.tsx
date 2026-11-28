// SPDX-License-Identifier: LicenseRef-Proprietary
import { dirname, resolve } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserEngine, browserTestOptimizeDeps, openBrowserTestPage, type Browser, type Page } from "../../lib/browser-test";
import { loadCatalog, t } from "@console/i18n";
import { EXPERIENCE_SOURCE_KEY } from "../../experience/store";
import { EXPERIENCE_KEY } from "../../lib/prefs";

const PREFS_JS = readFileSync(new URL("../../../public/prefs.js", import.meta.url), "utf8");

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let resetStorageOnBoot = true;
let workspaceLayout: Record<string, unknown> = { tabs: ["/people"] };
let tenantStyle: "console" | "baseline" | "warm-clear" = "console";
let writes: Record<string, unknown>[] = [];

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/experience-switch-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "experience-switch-test", resolveId: id => id === "/experience-switch-test.js" ? "\0experience-switch-test" : undefined,
      load: id => id === "\0experience-switch-test" ? `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { configure, session } from '@console/api';
        import { webPlatform } from '@console/api/web';
        import { loadCatalog, t } from '@console/i18n';
        import { ExperienceChooser } from '/apps/web/src/shell/frame/experience-chooser.tsx';
        import { useExperienceSync } from '/apps/web/src/experience/store.ts';
        import { useDraft } from '/apps/web/src/lib/react/use-draft.ts';
        import { Sheet } from '/apps/web/src/ui/sheet/sheet.tsx';
        import '/apps/web/src/app.css';

        window.bootToken = Math.random().toString(36).slice(2);
        configure({ ...webPlatform, passkeys: { get: async () => null, create: async () => null } });
        session.set({
          access_token: 'h.' + btoa(JSON.stringify({ sub: 'user-1', org: 'org-1', name: 'Test User' })) + '.s',
          token_type: 'Bearer',
          refresh_expires_at: '2099-01-01T00:00:00Z',
          requires_passkey_setup: false,
          privacy_consent_accepted: true,
        });
        await loadCatalog('ko');

        function Harness() {
          useExperienceSync(true);
          const [note, setNote] = useState('');
          const [sheetOpen, setSheetOpen] = useState(false);
          const [sheetValue, setSheetValue] = useState('');
          const draft = useDraft({ route: '/harness', record: 'new', form: 'wizard', initial: { title: '' }, text: v => v.title });
          return React.createElement('main', null,
            React.createElement('h1', null, 'Experience Harness'),
            React.createElement('label', { htmlFor: 'acct-exp' }, t('account.experience')),
            React.createElement(ExperienceChooser, { id: 'acct-exp' }),
            React.createElement('form', { className: 'form', onSubmit: e => { e.preventDefault(); } },
              React.createElement('label', { htmlFor: 'page-note' }, 'Page note'),
              React.createElement('input', { id: 'page-note', value: note, onChange: e => setNote(e.target.value) }),
              React.createElement('button', { type: 'button', onClick: () => setNote('') }, 'Discard page note'),
            ),
            React.createElement('button', { type: 'button', onClick: () => draft.set({ title: 'draft-title' }) }, 'Seed session draft'),
            React.createElement('button', { type: 'button', onClick: () => draft.discard() }, 'Discard session draft'),
            React.createElement('button', { type: 'button', onClick: () => { setSheetValue(''); setSheetOpen(true); } }, 'Open sheet'),
            React.createElement(Sheet, {
              open: sheetOpen,
              title: 'Edit record',
              onClose: () => setSheetOpen(false),
              consequence: 'Updates the record.',
              actions: React.createElement('button', { type: 'button', onClick: () => setSheetOpen(false) }, 'Close sheet'),
            },
              React.createElement('label', { htmlFor: 'sheet-input' }, 'Sheet input'),
              React.createElement('input', { id: 'sheet-input', value: sheetValue, onChange: e => setSheetValue(e.target.value) }),
            ),
          );
        }

        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
        createRoot(document.getElementById('root')).render(
          React.createElement(QueryClientProvider, { client }, React.createElement(Harness))
        );
      ` : undefined }],
  });
  await server.listen();
  browser = await browserEngine().launch();
  page = await browser.newPage();
  await page.route("**/prefs.js", route => {
    // Start each case on a fresh device. Reloads within the same case must see its saved preference.
    const reset = resetStorageOnBoot ? "localStorage.clear(); sessionStorage.clear();" : "";
    resetStorageOnBoot = false;
    return route.fulfill({
      contentType: "application/javascript",
      body: `${reset}\n${PREFS_JS}\nwindow.experienceAtBoot = document.documentElement.dataset.experience ?? null;`,
    });
  });
  await page.route("**/experience-switch-test", route => route.fulfill({
    contentType: "text/html",
    body: '<html lang="ko"><head><title>Experience</title><script src="/prefs.js"></script></head><body><div id="root"></div><script type="module" src="/experience-switch-test.js"></script></body></html>',
  }));
  await page.route("**/api/v1/me/workspace", async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { layout: Record<string, unknown> };
      writes.push(body.layout);
      workspaceLayout = body.layout;
      return route.fulfill({ status: 200, json: { layout: workspaceLayout } });
    }
    return route.fulfill({ status: 200, json: { layout: workspaceLayout } });
  });
  await page.route("**/api/v1/settings", route => route.fulfill({
    status: 200,
    json: {
      can_change: false,
      items: [{
        key: "display.experience",
        kind: { type: "code", allowed: ["baseline", "console", "warm-clear"] },
        default: "console",
        value: tenantStyle,
        looser_when: "neutral",
        governance: "tenant",
        legal_basis: null,
        version: tenantStyle === "console" ? "code_default" : "1",
        effective_from: null,
        source: { layer: tenantStyle === "console" ? "code_default" : "tenant", scope_entity_id: null },
        chain: [],
        scheduled: [],
      }],
    },
  }));
}, 60_000);

beforeEach(() => { resetStorageOnBoot = true; });
afterAll(async () => { await page?.close(); await browser?.close(); await server?.close(); });

test("style choice switches in place without reloading, saves personal override, and reverts to organization default", async () => {
  workspaceLayout = { tabs: ["/people"] };
  tenantStyle = "console";
  writes = [];
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}experience-switch-test`, page.getByRole("heading", { name: "Experience Harness" }));

  const chooser = page.getByRole("combobox", { name: t("account.experience"), exact: true });

  // Unconfigured tenant default (console) paints on frame 0 and stays console when settings settle, keeping storage clean.
  expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string | null }).experienceAtBoot)).toBe("console");
  await expect(chooser).toHaveValue("tenant");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
  expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBeNull();

  await page.reload({ waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Experience Harness" })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string | null }).experienceAtBoot)).toBe("console");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");

  const bootAfterReload = await page.evaluate(() => (window as Window & { bootToken?: string }).bootToken);

  // Choosing a personal override applies immediately without reloading and preserves existing workspace keys.
  await chooser.selectOption("baseline");
  await expect(chooser).toHaveValue("baseline");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");
  expect(await page.evaluate(() => (window as Window & { bootToken?: string }).bootToken)).toBe(bootAfterReload);
  await expect.poll(() => writes).toEqual([{ tabs: ["/people"], experience: "baseline" }]);
  expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBe("baseline");

  // Reloading with a personal Classic override paints Classic on frame 0 and stays Classic after settings settle.
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Experience Harness" })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string | null }).experienceAtBoot)).toBe("baseline");
  await expect(chooser).toHaveValue("baseline");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");

  const bootBeforeRevert = await page.evaluate(() => (window as Window & { bootToken?: string }).bootToken);

  // Choosing Follow organization default reverts immediately to tenantStyle (console) and clears personal storage.
  await chooser.selectOption("tenant");
  await expect(chooser).toHaveValue("tenant");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
  expect(await page.evaluate(() => (window as Window & { bootToken?: string }).bootToken)).toBe(bootBeforeRevert);
  await expect.poll(() => writes.at(-1)).toEqual({ tabs: ["/people"], experience: "tenant" });
  expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBeNull();
});

test("an explicit Classic tenant settles to baseline, caches the tenant default on the device, and paints baseline on reload", async () => {
  workspaceLayout = { tabs: ["/people"] };
  tenantStyle = "baseline";
  writes = [];
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}experience-switch-test`, page.getByRole("heading", { name: "Experience Harness" }));
  expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string }).experienceAtBoot)).toBe("console");

  const chooser = page.getByRole("combobox", { name: t("account.experience"), exact: true });
  await expect(chooser).toHaveValue("tenant");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");
  expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBe("baseline");
  expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_SOURCE_KEY)).toBe("tenant");

  // Reloading now paints baseline on frame 0 via prefs.js and keeps baseline settled.
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Experience Harness" })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string | null }).experienceAtBoot)).toBe("baseline");
  await expect(chooser).toHaveValue("tenant");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");

  // A personal Console override on an explicit Classic tenant wins on settle and on reload frame 0.
  await chooser.selectOption("console");
  await expect(chooser).toHaveValue("console");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Experience Harness" })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string | null }).experienceAtBoot)).toBe("console");
  await expect(chooser).toHaveValue("console");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
});

test("unsaved input in either a page form or a sheet refuses a style switch until discarded", async () => {
  workspaceLayout = { tabs: ["/people"], experience: "baseline" };
  tenantStyle = "baseline";
  writes = [];
  await openBrowserTestPage(page, `${server.resolvedUrls!.local[0]}experience-switch-test`, page.getByRole("heading", { name: "Experience Harness" }));

  const chooser = page.getByRole("combobox", { name: t("account.experience"), exact: true });
  await expect(chooser).toHaveValue("baseline");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");

  // 1. Dirty page form blocks the switch and preserves the typed text.
  const pageInput = page.getByLabel("Page note");
  await pageInput.fill("unsaved draft text");
  await chooser.selectOption("console");
  await expect(page.getByRole("alert")).toHaveText(t("account.experience.unsaved"));
  await expect(chooser).toHaveValue("baseline");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");
  await expect(pageInput).toHaveValue("unsaved draft text");
  expect(writes).toEqual([]);

  // Discarding the page form unblocks the switch.
  await page.getByRole("button", { name: "Discard page note" }).click();
  await chooser.selectOption("console");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(chooser).toHaveValue("console");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
  await expect.poll(() => writes).toEqual([{ tabs: ["/people"], experience: "console" }]);

  // 2. Dirty sheet also blocks a switch back until closed.
  await page.getByRole("button", { name: "Open sheet" }).click();
  const sheetInput = page.getByLabel("Sheet input");
  await sheetInput.fill("sheet draft");
  await chooser.evaluate((el: HTMLSelectElement) => {
    el.value = "baseline";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(chooser).toHaveValue("console");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
  await expect(sheetInput).toHaveValue("sheet draft");
  expect(writes).toHaveLength(1);

  await page.getByRole("button", { name: "Close sheet" }).click();
  await chooser.selectOption("baseline");
  await expect(chooser).toHaveValue("baseline");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");
  await expect.poll(() => writes).toHaveLength(2);

  // 3. Session-persisted useDraft wizard state also blocks a switch until discarded.
  await page.getByRole("button", { name: "Seed session draft" }).click();
  await chooser.selectOption("console");
  await expect(page.getByRole("alert")).toHaveText(t("account.experience.unsaved"));
  await expect(chooser).toHaveValue("baseline");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");
  expect(writes).toHaveLength(2);

  await page.getByRole("button", { name: "Discard session draft" }).click();
  await chooser.selectOption("console");
  await expect(chooser).toHaveValue("console");
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
  await expect.poll(() => writes).toHaveLength(3);
});
