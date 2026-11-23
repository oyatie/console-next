// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, test } from "vitest";
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
          navItems: [], displayName: 'Test', onNavigate: () => {}, onSearch: () => {} }),
        h('main', null, h(SingleKeysCheck))) });
      const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
      createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: new QueryClient() }, h(RouterProvider, { router })));
    `,
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("the search button's / follows the single-key switch at once, in this tab and from another", async () => {
  const { page } = mounted;
  const search = page.getByRole("button", { name: t("shell.jump"), exact: true });
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
