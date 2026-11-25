// SPDX-License-Identifier: LicenseRef-Proprietary
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";
import { SINGLE_KEYS_KEY } from "../../lib/prefs";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountBrowserModule({
    slug: "console-top-bar-single-keys",
    readySelector: 'header[data-surface="chrome"] button[aria-keyshortcuts]',
    viewport: { width: 1440, height: 900 },
    // The top bar and the device's single-key switch, both on screen, as on the account page.
    moduleCode: `
      import { createElement as h } from 'react';
      import { createRoot } from 'react-dom/client';
      import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { loadCatalog } from '@console/i18n';
      import { ConsoleTopBar } from '/apps/web/src/shell/console/console-top-bar.tsx';
      import { SingleKeysCheck } from '/apps/web/src/shell/frame/single-keys-check.tsx';
      import '/apps/web/src/app.css';
      await loadCatalog('ko');
      document.documentElement.dataset.experience = 'console';
      const rootRoute = createRootRoute({ component: () => h('div', null,
        h(ConsoleTopBar, { platform: false, restoring: false, defaultHref: '/', navigationState: 'ready', navigationNotice: null,
          navItems: [], displayName: 'Dana Kim · HR Manager', onNavigate: () => {}, onSearch: () => {} }),
        h('main', null, h(SingleKeysCheck))) });
      const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
      createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: new QueryClient() }, h(RouterProvider, { router })));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("the brand is an 18px mark drawn on the bar itself, its strokes in the bar's ink and its square in amber", async () => {
  const { page } = mounted;
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const mark = await page.locator('header[data-surface="chrome"] a[href="/"] svg').evaluate(svg => {
    const tiles: string[] = [];
    for (let el: Element | null = svg; el && el.tagName !== "HEADER"; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.backgroundColor !== "rgba(0, 0, 0, 0)" || s.borderTopWidth !== "0px" || s.outlineStyle !== "none") tiles.push(el.tagName);
    }
    const box = svg.getBoundingClientRect();
    const shapes = [...svg.querySelectorAll("rect, path")].map(shape => getComputedStyle(shape));
    return {
      size: [box.width, box.height], tiles,
      strokes: [...new Set(shapes.filter(s => s.stroke !== "none").map(s => s.stroke))],
      fills: [...new Set(shapes.filter(s => s.fill !== "none").map(s => s.fill))],
    };
  });
  expect(mark).toEqual({ size: [18, 18], tiles: [], strokes: ["rgb(238, 242, 246)"], fills: ["rgb(245, 189, 79)"] });
});

test("the search button is named by the shared search label and its visible words, and describes what it finds", async () => {
  const { page } = mounted;
  const search = page.getByRole("button", { name: t("shell.jumpLabel") });
  await element(search).toHaveAccessibleName(`${t("shell.jumpLabel")} ${t("shell.searchHint")}`);
  await element(search).toHaveAccessibleDescription(t("shell.jump"));
  // A label locator for a searchable thing (a registration number field, say) must not land on the search button.
  await element(page.getByLabel(t("shell.jump"))).toHaveCount(0);
  // The shared label is heard, not shown: the box draws the search hint alone.
  const label = await search.getByText(t("shell.jumpLabel"), { exact: true }).boundingBox();
  expect(label!.width).toBeLessThanOrEqual(1);
});

test("the search button's / follows the single-key switch at once, in this tab and from another", async () => {
  const { page } = mounted;
  const search = page.getByRole("button", { name: `${t("shell.jumpLabel")} ${t("shell.searchHint")}`, exact: true });
  const hint = search.locator("kbd");
  const toggle = page.getByRole("switch", { name: t("account.singleKeys") });

  await element(search).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K /");
  await element(hint).toHaveCount(1);

  // Off here: the button stops announcing the key and stops showing it.
  await toggle.click();
  await element(toggle).not.toBeChecked();
  await element(search).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");
  await element(hint).toHaveCount(0);

  // On from another tab: storage changes there reach this one as a storage event.
  await page.evaluate(key => {
    localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue: "off", newValue: null, storageArea: localStorage }));
  }, SINGLE_KEYS_KEY);
  await element(search).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K /");
  await element(hint).toHaveCount(1);
  await element(toggle).toBeChecked();
});

test("every bar control named apart from its text still says its visible text, so a spoken label reaches it", async () => {
  const { page } = mounted;
  // The account menu draws in place of its link once its code has loaded; both are checked.
  await page.locator("#console-top-account").waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const scan = await new AxeBuilder({ page }).include('header[data-surface="chrome"]').withRules(["label-content-name-mismatch", "button-name", "link-name"]).analyze();
    expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(" | ")}`), theme).toEqual([]);
  }
  // The search opens the palette, a dialog.
  await element(page.getByRole("button", { name: t("shell.jumpLabel") })).toHaveAttribute("aria-haspopup", "dialog");
  await element(page.locator("#console-top-account")).toHaveAccessibleName("Dana Kim · HR Manager");
});
