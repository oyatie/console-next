// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserTestOptimizeDeps } from "../../lib/browser-test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/composer-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "composer-test",
      resolveId: (id) => id === "/composer-test.js" ? "\0composer-test" : undefined,
      load: (id) => id === "\0composer-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { ApiError } from '@console/api';
        import { CommandError } from '/apps/web/src/lib/react/command-error.tsx';
        import { Composer } from '/apps/web/src/ui/composer/composer.tsx';
        import { TextArea } from '/apps/web/src/ui/field/text-area.tsx';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function Demo() {
          const [long, setLong] = useState(false);
          const [submits, setSubmits] = useState(0);
          const [remedies, setRemedies] = useState(0);
          const [error, setError] = useState();
          const state = new URLSearchParams(location.search).get('state');
          return h('main', null, h('h1', null, 'Record'),
            h('button', { id: 'toggle', onClick: () => setLong(x => !x) }, 'Change action'),
            h(Composer, { layout: state === 'drawer' || state === 'command-drawer-403' ? 'drawer' : state?.startsWith('page') || state === 'command-page-403' ? 'page' : 'inline', headingLevel: 3, commitId: 'commit',
              title: 'Review', action: { kind: long ? 'EMPLOYMENT_TYPE_CHANGE' : 'appointment', mode: long ? 'apply' : 'schedule', count: 3 },
              onClose: () => {}, onSubmit: state === 'refusal' ? undefined : () => { setSubmits(x => x + 1); if (state?.startsWith('command')) setError(new ApiError(Number(state.split('-')[2]), 'permission_denied', 'Server refusal')); },
              error, notice: h(CommandError, { error }), secondary: state?.startsWith('command') || state === 'locked' ? h('button', { id: 'alternate', onClick: () => setRemedies(x => x + 1) }, 'Alternate') : undefined, onSaveDraft: state?.startsWith('command') ? () => setRemedies(x => x + 1) : undefined,
              blocked: (error && state === 'command-blocked-403') || state === 'blocked' || state?.startsWith('locate') || (state === 'page-blocked' && !long) ? { reason: 'Resolve first', remedy: h('button', { id: 'remedy', onClick: () => setRemedies(x => x + 1) }, 'Register entity'), press: state?.startsWith('locate') ? () => setRemedies(x => x + 1) : undefined } : undefined,
              pending: state === 'locate-pending', loading: state === 'locate-loading',
              routing: state === 'routed' ? { routed: true, steps: [{ key: 'server-step', who: 'Resolved role', state: 'waiting' }] } : state === 'immediate' ? { routed: false, why: 'Resolved policy reason' } : undefined,
              locked: state === 'locked' || state === 'locate-locked', recovery: state === 'recovery' ? h('span', null, 'Checking') : undefined,
            }, state === 'refusal' ? h('form', { onSubmit: event => { event.preventDefault(); setRemedies(x => x + 1); } }, h('input', { 'aria-label': 'Reason' }), h('button', { type: 'submit' }, 'Request access')) : h(TextArea, { 'aria-label': 'Reason' })),
            h('output', { id: 'submits' }, submits), h('output', { id: 'remedies' }, remedies));
        }
        createRoot(document.getElementById('root')).render(h(Demo));
      ` : undefined,
      configureServer: (vite) => { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/composer-test?")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Composer</title><div id="root"></div><script type="module" src="/composer-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(10000);
}, 60_000);

test.each([390, 1440])("resolving a page block keeps both controls fixed at %ipx", async (width) => {
  await page.setViewportSize({ width, height: 900 });
  await open("page-blocked");
  const before = await actionBoxes();
  await page.locator("#toggle").click();
  await page.locator('#commit[type="submit"]').waitFor();
  await expect.poll(actionBoxes).toEqual(before);
});
afterAll(async () => { await browser?.close(); await server?.close(); });

const open = async (state: string) => {
  await page.goto(`${server.resolvedUrls!.local[0]}composer-test?state=${state}`);
  await page.getByRole("heading", { name: "Review" }).waitFor();
};

test("immediate routing explains the policy with a keyboard disclosure", async () => {
  await open("immediate");
  expect(await page.getByText("이 변경은 승인 없이 즉시 적용됩니다").isVisible()).toBe(true);
  expect(await page.getByText("Resolved policy reason").isVisible()).toBe(false);
  await page.getByText("이유 보기", { exact: true }).focus();
  await page.keyboard.press("Enter");
  expect(await page.getByText("Resolved policy reason").isVisible()).toBe(true);
  expect(await page.locator('[data-composer-section="approvals"]').count()).toBe(0);
});

test("routed changes show the resolved chain without an immediate-apply claim", async () => {
  await open("routed");
  expect(await page.locator('[data-composer-section="approvals"] ol').innerText()).toContain("Resolved role");
  expect(await page.getByText("이 변경은 승인 없이 즉시 적용됩니다").count()).toBe(0);
});

async function actionBoxes() {
  // A visible heading can still use fallback fonts; compare only after font layout finishes.
  await page.evaluate(() => document.fonts.ready);
  return Promise.all([page.locator("#commit"), page.getByRole("button", { name: "닫기", exact: true })].map((button) => button.boundingBox()));
}

test.each(["blocked", "locked", "recovery"])("%s refuses native form submission", async (state) => {
  await open(state);
  await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(await page.locator("#submits").textContent()).toBe("0");
  if (state === "blocked") {
    await page.locator("#remedy").click();
    expect(await page.locator("#remedies").textContent()).toBe("1");
  }
});

test("a refusal's recovery form submits independently without a composer commit", async () => {
  await open("refusal");
  expect(await page.locator("form").count()).toBe(1);
  expect(await page.locator("#commit").count()).toBe(0);
  await page.getByLabel("Reason").fill("Reviewed");
  await page.getByLabel("Reason").press("Enter");
  await page.waitForFunction(() => document.querySelector("#remedies")?.textContent === "1");
  expect(await page.locator("#submits").textContent()).toBe("0");
});

test.each(["locate", "locate-pending", "locate-loading", "locate-locked"])("%s only runs the opted-in blocked press when editable", async (state) => {
  await open(state);
  expect(await page.locator("#remedy").count()).toBe(1);
  await page.locator("#commit").click({ force: true });
  expect(await page.locator("#remedies").textContent()).toBe(state === "locate" ? "1" : "0");
  await page.getByLabel("Reason").press("Control+Enter");
  expect(await page.locator("#remedies").textContent()).toBe(state === "locate" ? "2" : "0");
  await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(await page.locator("#submits").textContent()).toBe("0");
});

test.each([[390, "inline"], [1440, "inline"], [390, "page"], [1440, "page"]] as const)("commit and dismiss boxes stay fixed at %ipx in %s", async (width, state) => {
  await page.setViewportSize({ width, height: 900 });
  await open(state);
  const before = await actionBoxes();
  await page.locator("#toggle").click();
  await page.getByRole("button", { name: /고용 형태 변경/ }).waitFor();
  await expect.poll(actionBoxes).toEqual(before);
  await page.getByLabel("Reason").fill("Reviewed");
  await page.getByLabel("Reason").press("Control+Enter");
  expect(await page.locator("#submits").textContent()).toBe("1");
});

test("composition-ending keyCode 229 in a textarea cannot commit", async () => {
  await open("page");
  const field = page.getByLabel("Reason");
  await field.focus();
  await field.dispatchEvent("compositionstart");
  await field.dispatchEvent("keydown", { key: "Enter", metaKey: true, isComposing: false, keyCode: 229 });
  expect(await page.locator("#submits").textContent()).toBe("0");
  await field.dispatchEvent("compositionend");
  await field.press("Control+Enter");
  expect(await page.locator("#submits").textContent()).toBe("1");
});


test.each(["inline", "page", "drawer"])("an authoritative command refusal locks %s without a caller lock", async (layout) => {
  await open(`command-${layout}-403`);
  const field = page.getByLabel("Reason");
  await field.fill("Reviewed");
  await page.locator("#commit").click();
  await expect.poll(() => page.locator("#commit").isDisabled()).toBe(true);
  expect(await page.getByRole("alert").count()).toBe(1);
  expect(await field.inputValue()).toBe("Reviewed");
  expect(await field.evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
  expect(await field.evaluate(el => getComputedStyle(el.closest("[inert]")!).opacity)).toBe("0.5");
  expect(await page.getByRole("button", { name: "임시 저장", exact: true }).isDisabled()).toBe(true);
  await page.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await page.locator("#commit").dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
  expect(await page.locator("#submits").textContent()).toBe("1");
  expect(await page.locator("#remedies").textContent()).toBe("0");
  expect(await page.locator("#alternate").evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
  expect(await page.getByRole("button", { name: "Alternate", includeHidden: true }).evaluate(el => getComputedStyle(el.closest("[inert]")!).opacity)).toBe("0.5");
  expect(await page.getByRole("button", { name: "닫기", exact: true }).isEnabled()).toBe(true);
});

test.each([409, 422])("a %i correction remains editable", async (status) => {
  await open(`command-inline-${status}`);
  await page.locator("#commit").click();
  await page.getByRole("alert").waitFor();
  expect(await page.locator("#commit").isEnabled()).toBe(true);
  expect(await page.getByLabel("Reason").evaluate(el => Boolean(el.closest("[inert]")))).toBe(false);
  await page.getByLabel("Reason").fill("Corrected");
  await page.getByLabel("Reason").press("Control+Enter");
  await expect.poll(() => page.locator("#submits").textContent()).toBe("2");
});


test("a permission refusal keeps a newly blocked form natively disabled", async () => {
  await open("command-blocked-403");
  await page.locator("#commit").click();
  await expect.poll(() => page.locator("#commit").evaluate(button => (button as HTMLButtonElement).disabled)).toBe(true);
  await page.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(await page.locator("#submits").textContent()).toBe("1");
});


test("an explicit body lock keeps existing secondary action layout and recovery usable", async () => {
  await open("locked");
  const action = page.locator("#alternate");
  expect(await action.evaluate(el => Boolean(el.closest("[inert]")))).toBe(false);
  expect(await action.evaluate(el => el.parentElement === document.querySelector("#commit")?.parentElement)).toBe(true);
  await action.click();
  expect(await page.locator("#remedies").textContent()).toBe("1");
});
