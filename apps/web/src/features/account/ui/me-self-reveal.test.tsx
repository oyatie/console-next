// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import type { QueryClient } from "@tanstack/react-query";
import { expect as browserExpect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type BrowserContext, type Page } from "../../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let pageErrors: string[] = [];

const PROFILE_FIXTURE = {
  employee_id: "emp-1",
  employment_status: "ACTIVE",
  phone_masked: "010-••••-4821",
  emergency_contacts_registered: true,
  emergency_contacts_count: 1,
  emergency_contacts: [{ name: "Minji", relation: "SPOUSE", phone_masked: "010-••••-9012" }],
  address_masked: "Pyeongtaek Godeok",
  bank_account_registered: false,
  open_change_requests: [],
};

beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({
    configFile: false, cacheDir: ".cache/me-self-reveal-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps, resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{
      name: "me-self-reveal-test",
      resolveId: (id) => (id === "/me-self-reveal-test.js" ? "\0me-self-reveal-test" : undefined),
      load: (id) => id === "\0me-self-reveal-test" ? `
        import { createElement as h } from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
        import { configure } from "@console/api";
        import { loadCatalog } from "@console/i18n";
        import { bindAnnouncer } from "/apps/web/src/lib/react/announce.ts";
        import { SelfEditableBody } from "/apps/web/src/features/account/ui/me-self-edit.tsx";
        await loadCatalog("ko");
        configure({ baseUrl: location.origin, refresh: { kind: "cookie" }, passkeys: { get: async () => ({ id: "proof" }), create: async () => null } });
        window.announcements = [];
        bindAnnouncer((msg) => window.announcements.push(msg));
        const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
        window.testClient = client;
        const profileQuery = { data: ${JSON.stringify(PROFILE_FIXTURE)}, isPending: false, isSuccess: true, isError: false, error: null, refetch: async () => ({ data: ${JSON.stringify(PROFILE_FIXTURE)} }) };
        const rootRoute = createRootRoute();
        const accountRoute = createRoute({ getParentRoute: () => rootRoute, path: "/account", component: () => h(SelfEditableBody, { employeeId: "emp-1", profileQuery }) });
        const leaveRoute = createRoute({ getParentRoute: () => rootRoute, path: "/leave", component: () => h("div", { "data-testid": "leave-route" }, "leave-route") });
        const router = createRouter({ routeTree: rootRoute.addChildren([accountRoute, leaveRoute]), history: createMemoryHistory({ initialEntries: ["/account"] }) });
        window.testNavigate = (to) => router.navigate({ to });
        const root = createRoot(document.getElementById("root"));
        window.testUnmount = () => root.unmount();
        root.render(h(QueryClientProvider, { client }, h(RouterProvider, { router })));
      ` : undefined,
      configureServer: (vite) => {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/me-self-reveal-test") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end('<!doctype html><html lang="ko"><head><title>Self Reveal</title></head><body><main id="root"></main><script type="module" src="/me-self-reveal-test.js"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  context = await browser.newContext();
  page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(err.message));
}, 60_000);

afterAll(async () => { await context?.close(); await browser?.close(); await server?.close(); });

beforeEach(async () => {
  pageErrors = [];
  await page.route("**/api/v1/auth/passkey/step-up/start", (route) =>
    route.fulfill({ json: { ceremony_id: "ceremony-1", challenge: { publicKey: {} } } }),
  );
  await page.route("**/api/v1/me/profile/reveal", (route) => {
    const body = route.request().postDataJSON() as { field: "PHONE" | "ADDRESS" | "EMERGENCY_CONTACTS" };
    if (body.field === "PHONE") return route.fulfill({ json: { employee_id: "emp-1", field: "PHONE", value: "+821099998888", display_seconds: 10 } });
    if (body.field === "ADDRESS") return route.fulfill({ json: { employee_id: "emp-1", field: "ADDRESS", value: { road_addr_part1: "123 Godeok-ro, Pyeongtaek-si 101-202" }, display_seconds: 10 } });
    return route.fulfill({ json: { employee_id: "emp-1", field: "EMERGENCY_CONTACTS", value: [{ name: "Minji", relation: "SPOUSE", phone: "+821055559012" }], display_seconds: 10 } });
  });
});

afterEach(async () => { await page?.unrouteAll({ behavior: "ignoreErrors" }); });

async function openHarness(targetPage: Page = page) {
  await targetPage.goto(`${server.resolvedUrls!.local[0]}me-self-reveal-test`);
  await targetPage.getByRole("list", { name: t("account.selfEdit.title") }).waitFor();
}

test("SelfEditableBody renders all 4 rows cleanly without exposing raw bank account inputs", async () => {
  await openHarness();
  const list = page.getByRole("list", { name: t("account.selfEdit.title") });
  await browserExpect(list).toContainText(t("account.selfEdit.phone"));
  await browserExpect(list).toContainText(t("account.selfEdit.emergency"));
  await browserExpect(list).toContainText(t("account.selfEdit.address"));
  await browserExpect(list).toContainText(t("account.selfEdit.bankAccount"));
  await browserExpect(list).toContainText(t("account.selfEdit.unregistered"));
  await browserExpect(
    page.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.phone") }), exact: true }),
  ).toBeVisible();
  const html = await page.locator("#root").innerHTML();
  expect(html).not.toContain("account_number");
  expect(html).not.toContain("bank_name");
  expect(pageErrors).toEqual([]);
});

test.each<{
  field: string;
  labelKey: "account.selfEdit.phone" | "account.selfEdit.address" | "account.selfEdit.emergency";
  revealedText: () => string;
  maskedText: () => string;
}>([
  {
    field: "PHONE",
    labelKey: "account.selfEdit.phone",
    revealedText: () => "010-9999-8888",
    maskedText: () => "010-••••-4821",
  },
  {
    field: "ADDRESS",
    labelKey: "account.selfEdit.address",
    revealedText: () => "123 Godeok-ro, Pyeongtaek-si 101-202",
    maskedText: () => "Pyeongtaek Godeok",
  },
  {
    field: "EMERGENCY_CONTACTS",
    labelKey: "account.selfEdit.emergency",
    revealedText: () => `Minji (${t("empCard.relation.SPOUSE")}) · 010-5555-9012`,
    maskedText: () => t("account.selfEdit.registered"),
  },
])("focus-away Escape re-masks revealed $field PII after clicking plaintext", async ({ labelKey, revealedText, maskedText }) => {
  await openHarness();
  await page.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t(labelKey) }), exact: true }).click();
  const revealed = revealedText();
  const masked = maskedText();
  const plaintext = page.getByText(revealed, { exact: true });
  await browserExpect(plaintext).toBeVisible();
  await browserExpect(page.getByRole("timer")).toBeVisible();

  await plaintext.click();
  await browserExpect(page.getByRole("button", { name: t("account.selfEdit.hide"), exact: true })).not.toBeFocused();

  await page.keyboard.press("Escape");
  await browserExpect(page.getByText(revealed, { exact: true })).toHaveCount(0);
  await browserExpect(page.getByRole("timer")).toHaveCount(0);
  await browserExpect(page.getByText(masked, { exact: true }).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("IME composing Escape keeps revealed PII shown until a non-composing Escape", async () => {
  await openHarness();
  await page.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.phone") }), exact: true }).click();
  const plaintext = page.getByText("010-9999-8888", { exact: true });
  await browserExpect(plaintext).toBeVisible();
  await plaintext.click();

  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    await page.evaluate(
      (eventInit) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...eventInit })),
      init,
    );
    await browserExpect(plaintext).toHaveCount(1);
  }

  await page.keyboard.press("Escape");
  await browserExpect(plaintext).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("revealed PII re-masks automatically on countdown expiry and is never stored in caches", async () => {
  await page.clock.install();
  try {
    await openHarness();
    await page.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.phone") }), exact: true }).click();

    const plaintext = page.getByText("010-9999-8888", { exact: true });
    await browserExpect(plaintext).toBeVisible();
    await browserExpect(page.getByRole("timer")).toHaveText(t("account.selfEdit.revealRemaining", { seconds: 10 }));

    const cacheLeak = await page.evaluate(() => {
      const qc = (window as unknown as { testClient: QueryClient }).testClient;
      return {
        mutations: qc.getMutationCache().getAll().length,
        queries: JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data)),
      };
    });
    expect(cacheLeak.mutations).toBe(0);
    expect(cacheLeak.queries).not.toContain("010-9999-8888");
    expect(cacheLeak.queries).not.toContain("+821099998888");

    await page.clock.fastForward(10_001);
    await browserExpect(plaintext).toHaveCount(0);
    await browserExpect(page.getByText("010-••••-4821", { exact: true })).toBeVisible();
    const announcements = await page.evaluate(() => (window as unknown as { announcements: string[] }).announcements);
    expect(announcements).toContain(t("empCard.reveal.remasked", { field: t("account.selfEdit.phone") }));
    expect(pageErrors).toEqual([]);
  } finally {
    await page.clock.resume();
  }
});

test("pathname navigation clears revealed PII state before returning to /account", async () => {
  await openHarness();
  await page.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.address") }), exact: true }).click();
  await browserExpect(page.getByText("123 Godeok-ro, Pyeongtaek-si 101-202", { exact: true })).toBeVisible();

  await page.evaluate(() => (window as unknown as { testNavigate: (to: string) => Promise<void> }).testNavigate("/leave"));
  await browserExpect(page.getByTestId("leave-route")).toBeVisible();
  await browserExpect(page.getByText("123 Godeok-ro, Pyeongtaek-si 101-202", { exact: true })).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { testNavigate: (to: string) => Promise<void> }).testNavigate("/account"));
  await browserExpect(page.getByText("Pyeongtaek Godeok", { exact: true })).toBeVisible();
  await browserExpect(page.getByText("123 Godeok-ro, Pyeongtaek-si 101-202", { exact: true })).toHaveCount(0);
  await browserExpect(page.getByRole("timer")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("unmounting clears revealed PII and tears down document keydown listener cleanly", async () => {
  await openHarness();
  await page.getByRole("button", { name: t("account.selfEdit.revealLabel", { field: t("account.selfEdit.phone") }), exact: true }).click();
  await browserExpect(page.getByText("010-9999-8888", { exact: true })).toBeVisible();

  await page.evaluate(() => (window as unknown as { testUnmount: () => void }).testUnmount());
  await browserExpect(page.getByText("010-9999-8888", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(pageErrors).toEqual([]);
});

test("PhoneEditButton rejects masked characters client-side before sending PATCH", async () => {
  let patchBodies: unknown[] = [];
  await page.route("**/api/v1/me/profile", (route) => {
    if (route.request().method() === "PATCH") {
      patchBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { ...PROFILE_FIXTURE, phone_masked: "010-••••-5432" } });
    }
    return route.fulfill({ json: PROFILE_FIXTURE });
  });
  await page.route("**/api/v1/users/me", (route) => route.fulfill({ json: { id: "u1" } }));

  await openHarness();
  await page.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: t("account.selfEdit.phoneEditTitle"), exact: true });
  const input = dialog.getByLabel(t("account.selfEdit.phone"));

  for (const maskedCandidate of ["010-••••-4821", "010-●●●●-4821", "010-1234-5678*"]) {
    await input.fill(maskedCandidate);
    await browserExpect(input).toHaveAttribute("aria-invalid", "true");
    await browserExpect(dialog).toContainText(t("account.selfEdit.emergencyPhoneInvalid"));
    await dialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
    await browserExpect(dialog).toBeVisible();
    expect(patchBodies).toEqual([]);
  }

  await input.fill("010-9876-5432");
  await browserExpect(input).not.toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: t("account.selfEdit.phoneEdit"), exact: true }).click();
  await browserExpect(dialog).toHaveCount(0);
  expect(patchBodies).toEqual([{ phone: "010-9876-5432" }]);
  expect(pageErrors).toEqual([]);
});
