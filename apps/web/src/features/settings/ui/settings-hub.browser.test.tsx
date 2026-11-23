// SPDX-License-Identifier: LicenseRef-Proprietary
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { loadCatalog, t } from "@console/i18n";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/settings-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), dirname(realpathSync("node_modules/pretendard"))] } },
    plugins: [{ name: "settings-test", resolveId: id => id === "/settings-test.js" ? "\0settings-test" : undefined,
      load: id => id === "\0settings-test" ? `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {createRootRoute,createRoute,createRouter,RouterProvider} from '@tanstack/react-router';
        import {loadCatalog} from '@console/i18n';
        import {SettingsHubView} from '/apps/web/src/features/settings/ui/settings-hub.tsx';
        import {SETTINGS_VIEWS} from '/apps/web/src/shell/settings-views.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        const root=createRootRoute({component:()=>React.createElement(SettingsHubView,{rows:SETTINGS_VIEWS})});
        const router=createRouter({routeTree:root.addChildren(SETTINGS_VIEWS.map(row=>createRoute({getParentRoute:()=>root,path:row.to})))});
        await router.load();
        createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false,staleTime:60000}}})},React.createElement(RouterProvider,{router})));
      ` : undefined }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/settings-test", route => route.fulfill({ contentType: "text/html", body: '<html lang="ko"><title>Settings</title><div id="root"></div><script type="module" src="/settings-test.js"></script></html>' }));
}, 60_000);
afterAll(async () => { await page?.close(); await browser?.close(); await server?.close(); });

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`settings links support the keyboard at ${width}px in ${theme}`, async () => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/v1/**", route => {
      const path = new URL(route.request().url()).pathname;
      const json = path.endsWith("company-domain/request") ? { pending_domain: "example.test" }
        : path.endsWith("employee-number-rules") ? [{ scope_kind: "TENANT", scope_id: "tenant", prefix: "E-", width: 4, next_number: "E-0012" }]
        : path.endsWith("users/me") ? { sign_in_id: "operator@current.test" }
        : path.endsWith("settings") ? { can_change: false, items: [
          { key: "approval.policy.org_structure", kind: { type: "code", allowed: ["none", "route"] }, value: "route", governance: "tenant", source: { layer: "tenant" }, scheduled: [{ value: "none", effective_from: "2026-12-01T00:00:00Z" }] },
          { key: "display.experience", kind: { type: "code", allowed: ["baseline", "console", "warm-clear"] }, value: "baseline", version: "code_default", governance: "tenant", source: { layer: "code_default" }, scheduled: [] },
        ] }
        : { items: [] };
      return route.fulfill({ json });
    });
    await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: t("shell.link.settings"), exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: t("shell.settings.domain"), exact: true })).toContainText("current.test · example.test · 신청 중");
    await expect(main.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText("E-0012");
    const approval = main.getByRole("region", { name: "결재", exact: true });
    await expect(approval).toContainText("조직 개편");
    await expect(approval).toContainText("2026. 12. 01.");
    await expect(approval.getByRole("link")).toHaveCount(0);
    const screenStyle = main.getByRole("region", { name: t("settingsHub.key.display.experience"), exact: true });
    await expect(screenStyle).toContainText(t("settingsHub.code.baseline"));
    await expect(screenStyle).toContainText(t("settingsHub.readOnly"));
    await expect(screenStyle.getByRole("button")).toHaveCount(0);
    const links = main.getByRole("link");
    await expect(links).toHaveCount(5);
    for (const link of await links.all()) await expect(link.locator("svg[aria-hidden=true]")).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(links.first()).toBeFocused();
    for (let i = 1; i < 5; i++) {
      await page.keyboard.press("Tab");
      await expect(links.nth(i)).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/people\/period-locks$/);
    expect(await main.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

for (const status of [403, 503]) test(`one ${status} summary leaves other cards and links available`, async () => {
  await page.route("**/api/v1/tenant/company-domain/request", route => route.fulfill({ status, json: { error: { code: "forbidden", message: "" } } }));
  await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
  const main = page.getByRole("main");
  await expect(main.getByRole("region", { name: t("shell.settings.domain"), exact: true })).toContainText("확인 불가");
  await expect(main.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText("E-0012");
  await expect(main.getByRole("link")).toHaveCount(5);
  await page.unroute("**/api/v1/tenant/company-domain/request");
});

for (const status of [403, 503]) test(`approval ${status} keeps its unavailable state within the card`, async () => {
  await page.route("**/api/v1/settings", route => route.fulfill({ status, json: { error: { code: "forbidden", message: "" } } }));
  await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
  await expect(page.getByRole("region", { name: "결재", exact: true })).toContainText("확인 불가");
  await expect(page.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText("E-0012");
  await page.unroute("**/api/v1/settings");
});

test("a live domain stays visible without a pending request", async () => {
  await page.route("**/api/v1/tenant/company-domain/request", route => route.fulfill({ json: { pending_domain: null } }));
  await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
  const card = page.getByRole("region", { name: t("shell.settings.domain"), exact: true });
  await expect(card).toContainText("current.test");
  await expect(card).not.toContainText("신청");
  await page.unroute("**/api/v1/tenant/company-domain/request");
});

test("unlabelled policy keys use the unavailable copy", async () => {
  await page.route("**/api/v1/settings", route => route.fulfill({ json: { can_change: true, items: [{ key: "approval.policy.unlabelled", kind: { type: "code", allowed: ["none", "route"] }, value: "route", governance: "tenant", source: { layer: "tenant" }, scheduled: [] }] } }));
  await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
  const card = page.getByRole("region", { name: "결재", exact: true });
  await expect(card).toContainText("확인 불가");
  await expect(card).not.toContainText("unlabelled");
  await page.unroute("**/api/v1/settings");
});

test("an unavailable identity cannot present a pending request as the live domain", async () => {
  await page.route("**/api/v1/users/me", route => route.fulfill({ status: 503, json: { error: { code: "service_unavailable", message: "" } } }));
  await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
  await expect(page.getByRole("region", { name: t("shell.settings.domain"), exact: true })).toContainText("확인 불가");
  await expect(page.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText("E-0012");
  await page.unroute("**/api/v1/users/me");
});

test("the domain waits for identity while other summaries are ready", async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/users/me", async route => { await held; await route.fulfill({ json: { sign_in_id: "operator@current.test" } }); });
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
    await expect(page.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText("E-0012");
    const card = page.getByRole("region", { name: t("shell.settings.domain"), exact: true });
    await expect(card.getByRole("status", { name: t("common.loading") })).toBeVisible();
    await expect(card).not.toContainText(t("settingsHub.unknown"));
    release();
    await expect(card).toContainText("current.test");
    await expect(card.getByRole("status")).toHaveCount(0);
  } finally { release(); await page.unroute("**/api/v1/users/me"); }
});

test("tenant default screen style composer validates, sends expected_version and reason, and surfaces version conflicts", async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let currentStyle = "baseline";
  let currentVersion = { override: "00000000-0000-4000-8000-000000000001" };
  let shouldConflict = true;
  const payloads: unknown[] = [];

  await page.route("**/api/v1/settings", route => route.fulfill({
    json: {
      can_change: true,
      items: [
        { key: "approval.policy.org_structure", kind: { type: "code", allowed: ["none", "route"] }, value: "none", governance: "tenant", source: { layer: "tenant" }, scheduled: [] },
        {
          key: "display.experience",
          kind: { type: "code", allowed: ["baseline", "console", "warm-clear"] },
          default: "baseline",
          looser_when: "neutral",
          value: currentStyle,
          version: currentVersion,
          governance: "tenant",
          source: { layer: "tenant", scope_entity_id: null },
          chain: [],
          scheduled: [],
        },
      ],
    },
  }));
  await page.route("**/api/v1/reason-codes**", route => route.fulfill({
    json: {
      domain: "settings_change",
      items: [
        { code: "POLICY_REVIEW", system: true, active: true, requires_note: false, sort: 1 },
        { code: "OTHER", system: true, active: true, requires_note: true, sort: 2 },
      ],
    },
  }));
  await page.route("**/api/v1/settings/display.experience**", async route => {
    payloads.push(route.request().postDataJSON());
    if (shouldConflict) {
      shouldConflict = false;
      currentVersion = { override: "00000000-0000-4000-8000-000000000002" };
      await route.fulfill({
        status: 409,
        json: { error: { code: "setting_version_stale", message: "stale", current_version: currentVersion } },
      });
      return;
    }
    currentStyle = "console";
    await route.fulfill({
      status: 201,
      json: {
        id: "00000000-0000-4000-8000-000000000003",
        key: "display.experience",
        value: "console",
        effective_from: "2026-11-20T00:00:00Z",
        scope_entity_id: null,
        immediate: true,
      },
    });
  });

  try {
    await page.goto(`${server.resolvedUrls!.local[0]}settings-test`);
    const card = page.getByRole("region", { name: t("settingsHub.key.display.experience"), exact: true });
    await expect(card).toContainText(t("settingsHub.code.baseline"));
    await card.getByRole("button", { name: t("settingsHub.experience.change"), exact: true }).click();

    const dialog = page.getByRole("dialog", { name: t("settingsHub.experience.sheetTitle"), exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: t("account.experience.warmClear") })).toHaveCount(0);

    const commitName = t("composer.commit", { action: t("settingsHub.key.display.experience"), verb: t("composer.verb.save"), count: 0, unit: "" });
    const commit = dialog.getByRole("button", { name: commitName, exact: true });
    const chooseRadio = (name: string) => dialog.getByRole("radio", { name, exact: true }).locator("xpath=ancestor::label[1]").click();
    await expect(commit).toHaveAttribute("aria-disabled", "true");

    await chooseRadio(t("account.experience.console"));
    await expect(commit).toHaveAttribute("aria-disabled", "true");

    await chooseRadio(t("reason.settings_change.OTHER"));
    await expect(commit).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("textbox", { name: new RegExp(t("settingsHub.experience.note")) }).fill("rollout");
    await expect(commit).not.toHaveAttribute("aria-disabled", "true");

    await chooseRadio(t("reason.settings_change.POLICY_REVIEW"));
    await commit.click();

    await expect(dialog.getByRole("alert")).toContainText(t("settingsHub.error.setting_version_stale"));
    await expect(dialog).toBeVisible();

    await commit.click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText(t("settingsHub.code.console"));
    expect(payloads).toEqual([
      { value: "console", reason_code: "POLICY_REVIEW", expected_version: { override: "00000000-0000-4000-8000-000000000001" } },
      { value: "console", reason_code: "POLICY_REVIEW", expected_version: { override: "00000000-0000-4000-8000-000000000002" } },
    ]);
  } finally {
    await page.unroute("**/api/v1/settings/display.experience**");
    await page.unroute("**/api/v1/reason-codes**");
    await page.unroute("**/api/v1/settings");
  }
});
