// SPDX-License-Identifier: LicenseRef-Proprietary
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect as expectElement, type Browser, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { pickerTestServer } from "./browser-test";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await pickerTestServer("picker-test", `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { ServerPicker } from '/apps/web/src/ui/server-picker/server-picker.tsx';
        import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
        import '/apps/web/src/app.css';
        await loadCatalog('en');
        function Picker() {
          const [query, setQuery] = useState('');
          const [value, setValue] = useState(null);
          const [clicks, setClicks] = useState(0);
          const [mounted, setMounted] = useState(true);
          const [sheetOpen, setSheetOpen] = useState(true);
          window.closeSheet = () => setSheetOpen(false);
          const picker = mounted && h(ServerPicker, { label: 'Person', group: 'People', empty: 'No people', query,
            onQueryChange: setQuery, value, onChange: setValue,
            options: [{ id: 'a', name: 'Namesake', display: 'Namesake · HR' }, { id: 'b', name: 'Namesake', display: 'Namesake · Sales' }, { id: 'c', name: 'Coded', code: 'E-3', display: 'Coded · E-3' }] });
          if (location.hash === '#sheet') return h('main', null,
            h('button', { id: 'outside', onClick: () => setClicks(n => n + 1) }, 'Outside'),
            h('output', { id: 'clicks' }, clicks),
            h(ModalOverlay, { isOpen: sheetOpen, onOpenChange: setSheetOpen }, h(Modal, null, h(Dialog, { 'aria-label': 'Sheet' }, picker))));
          return h('main', null,
            h('div', { inert: true }, h('button', { id: 'already-inert' }, 'Unavailable')),
            h('button', { id: 'outside', onClick: () => setClicks(n => n + 1) }, 'Outside'),
            mounted && h(ServerPicker, { label: 'Person', group: 'People', empty: 'No people', query,
              onQueryChange: setQuery, value, onChange: setValue,
              options: [{ id: 'a', name: 'Namesake', display: 'Namesake · HR' }, { id: 'b', name: 'Namesake', display: 'Namesake · Sales' }, { id: 'c', name: 'Coded', code: 'E-3', display: 'Coded · E-3' }] }),
            h('input', { id: 'after', 'aria-label': 'After' }),
            h('button', { id: 'unmount', onClick: () => setMounted(false) }, 'Unmount'),
            h('output', { id: 'selected' }, value), h('output', { id: 'clicks' }, clicks));
        }
        createRoot(document.getElementById('root')).render(h(Picker));
      `);
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  await page.getByRole("combobox", { name: "Person" }).waitFor();
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

test("an open picker passes axe in both themes and preserves existing inert restrictions on close", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  const input = page.getByRole("combobox", { name: "Person" });
  await input.fill("Namesake");
  await page.getByRole("option").first().waitFor();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    // React Aria's virtual-focus combobox deliberately leaves hidden content in the tab order.
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).disableRules(["aria-hidden-focus"]).analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  }
  await page.getByRole("option", { name: "Namesake · HR" }).click();
  await expectElement(input).toHaveAttribute("aria-expanded", "false");
  await expectElement(page.getByRole("option").first()).toBeHidden();
  await expectElement(page.locator("#already-inert").locator("..")).toHaveJSProperty("inert", true);
  await page.getByRole("button", { name: "Outside", exact: true }).focus();
  await expectElement(page.getByRole("button", { name: "Outside", exact: true })).toBeFocused();
}, 30000);

test("closing restores existing inert restrictions before the next microtask", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  const input = page.getByRole("combobox", { name: "Person" });
  await input.fill("Namesake");
  await page.getByRole("option").first().waitFor();
  await expectElement(page.locator("#outside")).toHaveAttribute("aria-hidden", "true");
  await page.locator("#already-inert").evaluate((el) => {
    const restricted = el.parentElement!;
    const combobox = document.querySelector('[role="combobox"]')!;
    restricted.dataset.exposed = "false";
    new MutationObserver(() => {
      if (combobox.getAttribute("aria-expanded") === "false" && !restricted.inert) restricted.dataset.exposed = "true";
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["inert", "aria-expanded"] });
  });
  await page.getByRole("option", { name: "Namesake · HR" }).click();
  await expectElement(input).toHaveAttribute("aria-expanded", "false");
  await expectElement(page.locator("#outside")).not.toHaveAttribute("aria-hidden", "true");
  const restricted = page.locator("#already-inert").locator("..");
  await expectElement(restricted).toHaveJSProperty("inert", true);
  await expectElement(restricted).toHaveAttribute("data-exposed", "false");
}, 10000);

test("a deliberately selected namesake without an employee number can be confirmed", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  await page.getByRole("combobox", { name: "Person" }).fill("Namesake");
  await page.getByRole("option", { name: "Namesake · Sales" }).click();
  await page.waitForFunction(() => document.querySelector("#selected")?.textContent === "b");
  expect(await page.locator("#selected").textContent()).toBe("b");
}, 10000);

test("unmounting an open picker retains outside restrictions", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  await page.getByRole("combobox", { name: "Person" }).fill("Namesake");
  await page.getByRole("option").first().waitFor();
  // A parent can unmount the picker without the pointer or blur first closing its popover.
  await page.locator("#unmount").evaluate((el: HTMLButtonElement) => el.click());
  await expectElement(page.getByRole("combobox")).toHaveCount(0);
  await expectElement(page.locator("#already-inert").locator("..")).toHaveJSProperty("inert", true);
}, 10000);

test("a Sheet that closes while its picker list is open leaves the page usable", async () => {
  await page.goto("about:blank"); // a hash-only change would not reload the harness
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test#sheet`);
  await page.getByRole("combobox", { name: "Person" }).fill("Namesake");
  await page.getByRole("option").first().waitFor();
  // Back or a route change unmounts the Sheet (ui/sheet wraps this same ModalOverlay) with its picker in one commit while the list is open.
  await page.evaluate(() => (window as unknown as { closeSheet: () => void }).closeSheet());
  await expectElement(page.getByRole("dialog")).toHaveCount(0);
  await expectElement(page.locator("[inert]")).toHaveCount(0);
  await page.locator("#outside").click();
  await expectElement(page.locator("#clicks")).toHaveText("1");
}, 10000);

test("one outside click activates its control while the picker is open", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  await page.getByRole("combobox", { name: "Person" }).fill("Namesake");
  await page.getByRole("option").first().waitFor();
  const bounds = await page.locator("#outside").boundingBox();
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await expectElement(page.locator("#clicks")).toHaveText("1");
  await page.getByRole("option").first().waitFor({ state: "hidden" });
}, 30000);

test("Tab and Shift+Tab leave an open picker for the adjacent controls", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  const input = page.getByRole("combobox", { name: "Person" });
  for (const [key, target] of [["Tab", "#after"], ["Shift+Tab", "#outside"]] as const) {
    await input.fill("Namesake");
    await page.getByRole("option").first().waitFor();
    await input.press(key);
    await expectElement(page.locator(target), key).toBeFocused();
    await page.getByRole("option").first().waitFor({ state: "hidden" });
    await input.clear();
  }
}, 30000);

test("a custom person label shows its employee number only once", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}picker-test`);
  await page.getByRole("combobox", { name: "Person" }).fill("Coded");
  const option = page.getByRole("option", { name: "Coded · E-3" });
  expect((await option.textContent())?.match(/E-3/g)).toHaveLength(1);
}, 10000);
