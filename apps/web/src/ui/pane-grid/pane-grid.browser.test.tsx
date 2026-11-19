// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "pane-grid",
    entryPath: "/apps/web/src/ui/pane-grid/pane-grid.gallery.tsx",
    readySelector: "[data-pane-grid-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("PaneGrid passes WCAG 2.2 AA axe checks and closes the side pane on Escape while dispatching open-in-tab", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
    (window as unknown as { openedTab?: unknown }).openedTab = null;
    window.addEventListener(
      "console:open-workspace-tab",
      event => {
        (window as unknown as { openedTab?: unknown }).openedTab = (event as CustomEvent).detail;
      },
      { once: true },
    );
  });

  await page.getByRole("button", { name: t("uiFlexibleColumns.openInTab") }).click();
  const openedTab = await page.evaluate(() => (window as unknown as { openedTab?: { href: string } }).openedTab);
  expect(openedTab?.href).toBe("/people");

  await page.locator('[data-pane="record"] button').first().focus();
  await page.keyboard.press("Escape");
  expect(await page.locator('[data-pane="record"]').count()).toBe(0);
});
