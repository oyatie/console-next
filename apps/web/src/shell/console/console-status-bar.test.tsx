// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mountBrowserModule, type MountedGallery } from "../../lib/gallery-browser-test";
import { ConsoleStatusBar } from "./console-status-bar";

beforeAll(() => loadCatalog("ko"));

// The status bar shows no search hint: the top bar's search already shows its key.
test("the status bar holds the screen's facts and no search hint", () => {
  const html = renderToStaticMarkup(<ConsoleStatusBar tenantName="Saeon" currentTitle="Home" inboxExact />);
  expect(html).toContain(">Home</div>");
  expect(html).not.toContain("<kbd");
  expect(html).not.toContain(t("shell.jumpLabel"));
});

describe("a screen's trailing fact", () => {
  let mounted: MountedGallery;

  beforeAll(async () => {
    mounted = await mountBrowserModule({
      slug: "console-status-bar-trailing",
      readySelector: "footer[data-surface='chrome']",
      viewport: { width: 1440, height: 900 },
      moduleCode: `
        import { createElement as h, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { loadCatalog } from '@console/i18n';
        import { ConsoleStatusBar } from '/apps/web/src/shell/console/console-status-bar.tsx';
        import { useScreenStatusBar } from '/apps/web/src/ui/status-bar/status-bar-store.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        document.documentElement.dataset.experience = 'console';
        // The screen publishes only its trailing fact; the pattern it renders publishes the segments.
        function Pattern() {
          useScreenStatusBar([{ id: 'doc', content: 'OC-2026-0418' }]);
          return null;
        }
        function Screen() {
          useScreenStatusBar(null, h('span', { 'data-queue': '' }, 'Position 1 of 4'));
          return h(Pattern);
        }
        function App() {
          const [open, setOpen] = useState(true);
          return h('main', null,
            h('button', { type: 'button', onClick: () => setOpen(false) }, 'Leave'),
            open ? h(Screen) : null,
            h(ConsoleStatusBar, { tenantName: 'Saeon', currentTitle: 'Home', inboxExact: true }));
        }
        createRoot(document.getElementById('root')).render(h(App));
      `,
    });
  }, 60_000);
  afterAll(async () => {
    await mounted?.close();
  });

  test("draws last beside its pattern's segments while the screen is open, and leaves with it", async () => {
    const { page } = mounted;
    const footer = page.locator("footer[data-surface='chrome']");
    await element(footer.locator(":scope > :last-child [data-queue]")).toHaveText("Position 1 of 4");
    await element(footer).toContainText("OC-2026-0418");
    await element(footer.locator("kbd")).toHaveCount(0);
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await element(footer.locator("[data-queue]")).toHaveCount(0);
    await element(footer).toContainText("Home");
  });
});
