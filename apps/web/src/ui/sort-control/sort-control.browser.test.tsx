// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "sort-control",
    entryPath: "/apps/web/src/ui/sort-control/sort-control.gallery.tsx",
    readySelector: "[data-sort-control-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("SortControl passes WCAG 2.2 AA axe checks and toggles sort direction on click", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  const toggle = page.getByRole("button", { name: new RegExp(t("uiLongTable.ascending")) }).first();
  await toggle.click();
  expect(await page.getByRole("button", { name: new RegExp(t("uiLongTable.descending")) }).count()).toBeGreaterThanOrEqual(1);
});
