// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect as dom, firefox } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../lib/browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/mat-form-test", logLevel: "error",
    optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "mat-form-test",
      resolveId: id => id === "/form-test.js" ? "\0form-test" : undefined,
      load: id => id === "\0form-test" ? `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { i18n, loadCatalog } from '@console/i18n';
        import { configure, ApiError } from '@console/api';
        import { webPlatform } from '@console/api/web';
        import { CommandError } from '/apps/web/src/lib/react/command-error.tsx';
        import { Form, Button } from '/apps/web/src/ui/button/button.tsx';
        import { Field, TextInput } from '/apps/web/src/ui/field/field.tsx';
        import '/apps/web/src/app.css';
        configure(webPlatform);
        const locale = new URLSearchParams(location.search).get('locale') ?? 'ko';
        i18n.set(locale);
        await loadCatalog(locale);
        function Demo() {
          const [count, setCount] = useState(0), [keys, setKeys] = useState(0), [name, setName] = useState(''), [note, setNote] = useState('');
          const [bubbles, setBubbles] = useState(0), [inline, setInline] = useState('');
          const [serverError, setServerError] = useState(null);
          return h('main', null, h('h1', null, 'Synthetic form'),
            h(Form, { id: 'sample-form', onSubmit: () => setCount(n => n + 1), onKeyDown: e => { if (e.key === 'Enter') setBubbles(n => n + 1); } },
              h(Field, { id: 'name', label: '이름', required: true }, p => h(TextInput, { ...p, name: 'name', value: name, onChange: e => setName(e.target.value), onKeyDown: e => { if (e.metaKey && e.key === 'Enter') { setKeys(n => n + 1); e.currentTarget.form.requestSubmit(); } } })),
              h(Field, { id: 'note', label: 'Note', required: true }, p => h(TextInput, { ...p, name: 'note', value: note, onChange: e => setNote(e.target.value) })),
              h(Button, { type: 'submit', value: 'save' }, 'Save')),
            h(Form, { id: 'inline-form', className: 'row', onSubmit: () => { setCount(n => n + 1); setInline(''); } },
              h(Field, { label: 'Inline name', required: true }, p => h(TextInput, { ...p, value: inline, onChange: e => setInline(e.target.value) })),
              h(Button, { type: 'submit' }, 'Add')),
            h(Form, { id: 'manual-validation', noValidate: true, onSubmit: () => setCount(n => n + 1) },
              h(Field, { label: 'Custom name', required: true }, p => h(TextInput, { ...p, name: 'custom-name' })),
              h(Field, { label: 'Custom note', required: true }, p => h(TextInput, { ...p, name: 'custom-note' })),
              h(Button, { type: 'submit' }, 'Custom submit')),
            h(Form, { id: 'native-validation', onSubmit: () => setCount(n => n + 1) },
              h(Field, { id: 'constrained', label: h('strong', null, '검증값'), required: true, tag: '추가 표시' }, p => h(TextInput, { ...p, name: 'constrained' })),
              h('label', null, 'Unassigned', h(TextInput, { name: 'unassigned', required: true })),
              h(Button, { type: 'submit' }, 'Validate')),
            h('button', { id: 'server-refusal', onClick: () => setServerError(ApiError.fromBody(new Response(null, { status: 422 }), { error: { code: 'validation', message: 'internal diagnostic', errors: [{ field: 'name', code: 'required' }, { field: 'note', code: 'required' }] } })) }, 'Server refusal'),
            h(CommandError, { error: serverError, formId: 'sample-form', formFields: ['name', 'note'] }),
            h('output', { id: 'count' }, count), h('output', { id: 'keys' }, keys), h('output', { id: 'bubbles' }, bubbles));
        }
        createRoot(document.getElementById('root')).render(h(Demo));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/form-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><html lang="ko"><title>Form</title><div id="root"></div><script type="module" src="/form-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await (process.env.E2E_XBROWSER === "1" ? firefox : chromium).launch();
  page = await browser.newPage();
  page.setDefaultTimeout(4000);
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

async function open(locale = "ko") {
  await page.goto(`${server.resolvedUrls!.local[0]}form-test?locale=${locale}`);
  await dom(page.getByRole("heading", { name: "Synthetic form" })).toBeVisible();
}

test("submit focuses the summary, links focus both inputs and revalidation keeps typing focus", async () => {
  await open();
  const summary = page.locator('#sample-form [data-component="error-summary"]');
  await dom(summary).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await dom(summary).toBeFocused();
  await dom(summary.locator("a")).toHaveCount(2);
  await dom(summary.locator('a[href="#name"]')).toHaveText("이름: 필수 항목입니다.");
  for (const id of ["name", "note"]) {
    await summary.locator(`a[href="#${id}"]`).click();
    await dom(page.locator(`#${id}`)).toBeFocused();
    await page.locator(`#${id}`).fill("Synthetic value");
    await dom(page.locator(`#${id}`)).toBeFocused();
  }
  await dom(summary).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await dom(page.locator("#count")).toHaveText("1");
});

test.each(["sample-form", "inline-form"])("%s: success, then clear the field keeps focus in the input", async id => {
  await open();
  const form = page.locator(`#${id}`);
  const input = form.getByRole("textbox").first();
  const summary = form.locator('[data-component="error-summary"]');
  for (const field of await form.getByRole("textbox").all()) await field.fill("Synthetic value");
  await form.getByRole("button", { name: /^(Save|Add)$/ }).click();
  await dom(page.locator("#count")).toHaveText("1");
  await input.fill("김철수");
  await input.fill("");
  await dom(input).toBeFocused();
  await dom(summary).toHaveCount(0);
  await input.pressSequentially("김철수");
  await dom(input).toHaveValue("김철수");
  await dom(input).toBeFocused();
});

test("a failed submit focuses again after correction and a successful submit", async () => {
  await open();
  const form = page.locator("#sample-form");
  const submit = form.getByRole("button", { name: "Save", exact: true });
  const summary = form.locator('[data-component="error-summary"]');
  await submit.click();
  await dom(summary).toBeFocused();
  for (const input of await form.getByRole("textbox").all()) await input.fill("Synthetic value");
  await submit.click();
  await dom(page.locator("#count")).toHaveText("1");
  await form.getByRole("textbox").first().fill("");
  await submit.click();
  await dom(summary).toBeFocused();
  await dom(summary.getByRole("link")).toHaveCount(1);
  await dom(page.locator("#count")).toHaveText("1");
});

for (const width of [1440, 390]) {
  test.each(["light", "dark"])(`inline summary occupies its own row at ${width}px in %s`, async theme => {
    await page.setViewportSize({ width, height: 900 });
    await open();
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const form = page.locator("#inline-form");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    const summary = await form.locator('[data-component="error-summary"]').boundingBox();
    const bounds = await form.boundingBox();
    const label = await form.locator("label").boundingBox();
    await page.screenshot({ path: `.cache/mat-form-test/row-${width}-${theme}.png` });
    expect(summary!.width).toBeCloseTo(bounds!.width, 0);
    expect(summary!.y + summary!.height).toBeLessThanOrEqual(label!.y);
  });
}

test.each([{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }])("IME Enter %j cannot reach the submit handler with an invalid sibling", async state => {
  await open();
  const field = page.getByRole("textbox", { name: /^이름/ });
  await field.focus();
  await field.dispatchEvent("compositionstart");
  await field.dispatchEvent("keydown", { key: "Enter", metaKey: true, ...state });
  await dom(page.locator("#keys")).toHaveText("0");
  await dom(page.locator("#bubbles")).toHaveText("0");
  await dom(page.locator('[data-component="error-summary"]')).toHaveCount(0);
  await dom(field).toBeFocused();
  await field.dispatchEvent("compositionend");
  await field.press("Meta+Enter");
  await dom(page.locator("#keys")).toHaveText("1");
  await dom(page.locator("#bubbles")).toHaveText("1");
  await dom(page.locator('#sample-form [data-component="error-summary"]')).toBeFocused();
  await dom(page.locator("#count")).toHaveText("0");
});

test("CommandError maps API field refusals to stable inputs without raw diagnostics", async () => {
  await open();
  await page.locator("#server-refusal").click();
  const summary = page.locator('[data-component="error-summary"]');
  await dom(summary).toBeFocused();
  await dom(summary.locator("a")).toHaveCount(2);
  for (const id of ["name", "note"]) {
    await summary.locator(`a[href="#${id}"]`).click();
    await dom(page.locator(`#${id}`)).toBeFocused();
  }
  await dom(summary).not.toContainText("internal diagnostic");
});

test("multiple summaries own distinct accessible headings", async () => {
  await open();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#server-refusal").click();
  const ids = await page.locator('[data-component="error-summary"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-labelledby")));
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});

test("custom validation opt-out stays intact while repairing a submitted form", async () => {
  await open();
  await page.getByRole("button", { name: "Custom submit", exact: true }).click();
  await dom(page.locator("#count")).toHaveText("1");
  const field = page.getByRole("textbox", { name: /^Custom name/ });
  await field.fill("Repair");
  await dom(field).toBeFocused();
  await dom(page.locator('#manual-validation [data-component="error-summary"]')).toHaveCount(0);
});

const validityCases = [
  { flag: "valueMissing", attrs: {}, value: "", ko: "필수 항목입니다.", en: "This field is required." },
  { flag: "typeMismatch", attrs: { type: "email" }, value: "invalid", ko: "올바른 형식으로 입력하십시오.", en: "Enter a value in the correct format." },
  { flag: "patternMismatch", attrs: { pattern: "[0-9]+" }, value: "abc", ko: "지정된 형식에 맞게 입력하십시오.", en: "Enter a value matching the required pattern." },
  { flag: "tooShort", attrs: { minlength: "3" }, value: "a", ko: "입력한 내용이 너무 짧습니다.", en: "The value is too short." },
  { flag: "tooLong", attrs: { maxlength: "1" }, value: "abc", ko: "입력한 내용이 너무 깁니다.", en: "The value is too long." },
  { flag: "rangeUnderflow", attrs: { type: "number", min: "2" }, value: "1", ko: "최솟값 이상으로 입력하십시오.", en: "Enter a value at or above the minimum." },
  { flag: "rangeOverflow", attrs: { type: "number", max: "2" }, value: "3", ko: "최댓값 이하로 입력하십시오.", en: "Enter a value at or below the maximum." },
  { flag: "stepMismatch", attrs: { type: "number", step: "2" }, value: "3", ko: "허용된 간격에 맞게 입력하십시오.", en: "Enter a value matching the allowed step." },
  { flag: "badInput", attrs: { type: "number" }, value: "-", ko: "올바른 값을 입력하십시오.", en: "Enter a valid value." },
  { flag: "customError", attrs: { type: "email" }, value: "invalid", ko: "Custom refusal", en: "Custom refusal" },
] as const;

for (const locale of ["ko", "en"] as const) {
  test.each(validityCases)(`${locale}: $flag uses catalog copy and excludes the marker and tag`, async ({ flag, attrs, value, ...copy }) => {
    await open(locale);
    const input = page.locator("#constrained");
    await input.evaluate((el: HTMLInputElement, type) => { el.type = type; el.required = false; }, "type" in attrs ? attrs.type : "text");
    if (value) await input.pressSequentially(value);
    await input.evaluate((el: HTMLInputElement, state) => {
      el.required = state.flag === "valueMissing";
      for (const [key, attr] of Object.entries(state.attrs)) el.setAttribute(key, attr);
      if (state.flag === "customError") el.setCustomValidity("Custom refusal");
    }, { flag, attrs });
    expect(await input.evaluate((el: HTMLInputElement, key) => el.validity[key], flag)).toBe(true);
    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await dom(page.locator('#native-validation a[href="#constrained"]')).toHaveText(`검증값: ${copy[locale]}`);
    await dom(page.locator("#count")).toHaveText("0");
  });
}

test("an input without an id gets a stable summary link that focuses it", async () => {
  await open();
  const input = page.getByRole("textbox", { name: "Unassigned", exact: true });
  await dom(input).not.toHaveAttribute("id");
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  const id = await input.getAttribute("id");
  expect(id).toBeTruthy();
  const link = page.locator('#native-validation [data-component="error-summary"]').getByRole("link", { name: /^Unassigned:/ });
  await dom(link).toHaveAttribute("href", `#${id}`);
  await link.click();
  await dom(input).toBeFocused();
  await input.fill("Repair");
  await dom(link).toHaveCount(0);
  await input.fill("");
  await dom(link).toHaveAttribute("href", `#${id}`);
  await link.click();
  await dom(input).toBeFocused();
});
