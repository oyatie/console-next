// SPDX-License-Identifier: LicenseRef-Proprietary
import { chromium, expect as expectElement, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ViteDevServer } from "vite";
import { pickerTestServer } from "./browser-test";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let catalogCount = 15;

beforeAll(async () => {
  server = await pickerTestServer("picker-states", `
    import { createElement as h, useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { loadCatalog } from '@console/i18n';
    import { ServerPicker } from '/apps/web/src/ui/server-picker/server-picker.tsx';
    import { PickOne } from '/apps/web/src/reference/entity/ui/pick-one.tsx';
    import { RolePick } from '/apps/web/src/features/access/ui/role-pick.tsx';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { CatalogPicker } from '/apps/web/src/features/people/ui/catalog-picker.tsx';
    import '/apps/web/src/app.css';
    await loadCatalog('ko');
    function Fixture({ mode, count, onReady }) {
      const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      useEffect(() => { onReady?.(); }, [onReady]);
      const [query, setQuery] = useState(mode === 'required' ? '' : 'alias');
      const [value, setValue] = useState(null);
      const [loading, setLoading] = useState(mode === 'loading');
      window.finishLoading = () => setLoading(false);
      const options = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: 'Employee ' + i, code: 'E-' + i }));
      const choices = options.slice(0, count).map(o => ({ value: o.id, label: o.name }));
      return h(QueryClientProvider, { client }, h('main', null,
        h('button', { id: 'before' }, 'Before'),
        mode === 'catalog' ? h(CatalogPicker, { kind: 'TITLE', label: 'Title', currentId: '0', required: false, value, onChange: setValue }) :
        mode === 'entity' ? h(PickOne, { label: 'Entity', required: true, options: choices, value, onChange: setValue, group: 'Entities', empty: 'No entities' }) :
        mode === 'role' ? h(RolePick, { label: 'Role', roles: choices.map(o => ({ id: o.value, name_ko: o.label, lines: [] })), value, onChange: setValue }) :
        h(ServerPicker, { label: 'Person', group: 'People', empty: 'No people', query, onQueryChange: setQuery,
          options: ['empty', 'readonly-empty', 'disabled-empty', 'error-empty'].includes(mode) ? [] : options,
          value, onChange: setValue, total: mode === 'complete' ? options.length : mode === 'unknown-total' ? undefined : 2000, loading, isRequired: true,
          readOnly: mode === 'readonly' || mode === 'readonly-empty',
          disabledReason: mode === 'disabled' || mode === 'disabled-empty' ? 'Approval required' : undefined,
          error: mode === 'error' || mode === 'error-empty' ? 'Choose a person' : undefined,
          escape: { kind: 'request', label: 'Request addition', note: 'Ask the owner', onRequest: () => setValue('request') } }),
        h('input', { id: 'after', 'aria-label': 'After' }),
        h('output', { id: 'selected' }, value)));
    }
    function App() {
      const [fixture, setFixture] = useState({ mode: 'results', count: 15, revision: 0 });
      window.renderFixture = (mode, count) => new Promise(onReady => {
        setFixture(previous => ({ mode, count, onReady, revision: previous.revision + 1 }));
      });
      return h(Fixture, { ...fixture, key: fixture.revision });
    }
    createRoot(document.getElementById('root')).render(h(App));
  `);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(10_000);
  await page.route("**/api/v1/job-titles", route => {
    return route.fulfill({ json: { items: Array.from({ length: catalogCount }, (_, n) => ({
      id: String(n), kind: "TITLE", label: `Employee ${n}`, active: true, grade_rank: null,
    })), can_manage: false } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}picker-states`);
  await page.getByRole("combobox").waitFor({ timeout: 30_000 });
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

async function open(mode: string, count = 15) {
  catalogCount = count;
  // Remount state, then await React's commit before tests move focus to the preceding button.
  await page.evaluate(config => (window as unknown as {
    renderFixture: (mode: string, count: number) => Promise<void>;
  }).renderFixture(config.mode, config.count), { mode, count });
  return page.getByRole("combobox", { name: "Person" });
}

test("server matches survive an alias query and the total is announced once, only while open", async () => {
  const input = await open("results");
  const count = page.getByRole("status").filter({ hasText: /^2,000건$/ });
  await expectElement(count).toHaveCount(0);
  await input.press("ArrowDown");
  await expectElement(page.getByRole("option")).toHaveCount(20);
  await expectElement(count).toHaveCount(1);
  await page.getByRole("option", { name: "Employee 19 E-19", exact: true }).click();
  await expectElement(page.locator("#selected")).toHaveText("19");
  await expectElement(count).toHaveCount(0);
});

test("changing fixture modes resets selection and overlays without reloading the module graph", async () => {
  const input = await open("results");
  await input.press("ArrowDown");
  await page.getByRole("option", { name: "Employee 19 E-19", exact: true }).click();
  await expectElement(page.locator("#selected")).toHaveText("19");
  await input.press("ArrowDown");
  await expectElement(page.getByRole("listbox")).toBeVisible();
  const navigations: string[] = [];
  const navigated = () => { navigations.push(page.url()); };
  page.on("domcontentloaded", navigated);
  try {
    const readOnly = await open("readonly");
    await expectElement(readOnly).toHaveValue("alias");
    await expectElement(page.locator("#selected")).toBeEmpty();
    await expectElement(page.getByRole("listbox")).toHaveCount(0);
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    await expectElement(readOnly).toBeFocused();
    expect(navigations).toEqual([]);
  } finally { page.off("domcontentloaded", navigated); }
});

test("loading changes to the result count in the same live region", async () => {
  const input = await open("loading");
  await input.press("ArrowDown");
  const status = page.getByRole("status");
  await expectElement(status).toHaveText("찾는 중");
  await page.evaluate(() => (window as unknown as { finishLoading: () => void }).finishLoading());
  await expectElement(status).toHaveText("2,000건");
});

test("only a settled, truncated result page asks the user to narrow the search", async () => {
  const hint = page.getByText("처음 20건만 표시합니다. 검색어를 더 입력해 범위를 좁히십시오.", { exact: true });
  for (const mode of ["complete", "unknown-total", "loading"]) {
    const input = await open(mode);
    await input.press("ArrowDown");
    await expectElement(page.getByRole("listbox")).toBeVisible();
    await expectElement(hint).toHaveCount(0);
  }
  const input = await open("results");
  await expectElement(hint).toHaveCount(0);
  await input.press("ArrowDown");
  await expectElement(hint).toBeVisible();
  await input.press("Tab");
  await expectElement(hint).toHaveCount(0);
});

test("an empty page with a positive total does not ask to narrow zero results", async () => {
  const input = await open("empty");
  await input.press("ArrowDown");
  await expectElement(page.getByRole("listbox")).toBeVisible();
  await expectElement(page.getByText(/처음 0건만 표시합니다/)).toHaveCount(0);
});

test("the narrowing guidance is exposed to assistive technology, keyboard tips are decorative", async () => {
  for (const mode of ["complete", "results"]) {
    const input = await open(mode);
    await input.press("ArrowDown");
    const footer = page.getByText(mode === "results" ? "처음 20건만 표시합니다. 검색어를 더 입력해 범위를 좁히십시오." : "↑↓ 이동 · Enter 선택 · 이름이 겹치면 사번이나 소속, 로그인 아이디를 확인합니다", { exact: true });
    await expectElement(footer).toBeVisible();
    if (mode === "results") await expectElement(footer).not.toHaveAttribute("aria-hidden", "true");
    else await expectElement(footer).toHaveAttribute("aria-hidden", "true");
  }
});

test("a failed empty search reports the error without a no-match escape", async () => {
  const input = await open("error-empty");
  await expectElement(input).toHaveAccessibleDescription("Choose a person");
  await expectElement(page.getByText("No people", { exact: true })).toHaveCount(0);
  await expectElement(page.getByRole("button", { name: "Request addition" })).toHaveCount(0);
});

test("field states use the theme tokens and preserve the read-only focus ring", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const mode of ["readonly", "disabled"]) {
      const input = await open(mode);
      if (mode === "readonly") {
        await page.locator("#before").focus();
        await page.keyboard.press("Tab");
        await expectElement(input).toBeFocused();
        await expectElement(input).toHaveCSS("border-top-style", "dashed");
      } else await expectElement(input).toHaveCSS("cursor", "not-allowed");
      const background = await page.evaluate((token) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = `var(${token})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      }, mode === "readonly" ? "--canvas" : "--muted");
      await expectElement(input).toHaveCSS("background-color", background);
    }
  }
});

test("catalog titles use the shared list/search boundary and keep selection and clearing", async () => {
  for (const count of [15, 16]) {
    await open("catalog", count);
    if (count === 15) {
      await expectElement(page.getByRole("combobox")).toHaveCount(0);
      await expectElement(page.getByRole("radio", { name: /Employee 0/ })).toBeDisabled();
      await page.getByRole("radio", { name: "Employee 1", exact: true }).press("Space");
    } else {
      const input = page.getByRole("combobox", { name: "Title" });
      await input.fill("Employee");
      await expectElement(page.getByRole("option", { name: "Employee 0", exact: true })).toHaveCount(0);
      await page.getByRole("option", { name: "Employee 1", exact: true }).click();
    }
    await expectElement(page.locator("#selected")).toHaveText("1");
    await page.getByRole("button", { name: "그대로", exact: true }).click();
    await expectElement(page.locator("#selected")).toBeEmpty();
  }
});

test("read-only remains in the tab order and cannot edit, open or select", async () => {
  const input = await open("readonly");
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  await expectElement(input).toBeFocused();
  await expectElement(input).toHaveAttribute("readonly", "");
  await input.press("x");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expectElement(input).toHaveValue("alias");
  await expectElement(page.getByRole("listbox")).toHaveCount(0);
  await expectElement(page.locator("#selected")).toBeEmpty();
  await input.press("Tab");
  await expectElement(page.locator("#after")).toBeFocused();
});

test("disabled exposes its reason as the input description and is skipped by Tab", async () => {
  const input = await open("disabled");
  await expectElement(input).toBeDisabled();
  await expectElement(input).toHaveAccessibleDescription("Approval required");
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  await expectElement(page.locator("#after")).toBeFocused();
});

test("an invalid picker associates the error with its input", async () => {
  const input = await open("error");
  await expectElement(input).toHaveAttribute("aria-invalid", "true");
  await expectElement(input).toHaveAccessibleDescription("Choose a person");
  const danger = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.borderColor = "var(--danger-solid)";
    document.body.append(probe);
    const color = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return color;
  });
  await expectElement(input).toHaveCSS("border-top-color", danger);
});

test("required pickers retain native required validation", async () => {
  const input = await open("required");
  await expectElement(input).toHaveAttribute("required", "");
  await expectElement(input).toHaveValue("");
});

test("read-only and disabled empty states cannot request a new item", async () => {
  for (const mode of ["readonly-empty", "disabled-empty"]) {
    await open(mode);
    await expectElement(page.getByRole("button", { name: "Request addition" })).toBeDisabled();
  }
  await open("empty");
  await page.getByRole("button", { name: "Request addition" }).click();
  await expectElement(page.locator("#selected")).toHaveText("request");
});

for (const mode of ["entity", "role"]) {
  test(`${mode} uses a list at 15 options and search at 16 without changing selection`, async () => {
    for (const count of [15, 16]) {
      await open(mode, count);
      const input = page.getByRole("combobox");
      if (count === 15) {
        if (mode === "entity") await input.selectOption("1");
        else {
          await page.getByRole("button", { name: /Role/ }).click();
          await page.getByRole("option", { name: "Employee 1", exact: true }).click();
        }
      } else {
        await input.fill("Employee 1");
        await page.getByRole("option", { name: "Employee 1", exact: true }).click();
      }
      await expectElement(page.locator("#selected")).toHaveText("1");
    }
  });
}
