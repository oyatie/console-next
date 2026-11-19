// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "worklist-pattern",
    entryPath: "/apps/web/src/ui/patterns/worklist.fixture.tsx",
    readySelector: '[data-pattern="worklist"]',
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Worklist pattern passes WCAG 2.2 AA axe checks at 1440 and 390 and filters and dismisses the record pane", async () => {
  const { page } = mounted;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await scanWcag22Matrix(page)).toEqual([]);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });

  await page.getByRole("button", { name: new RegExp(t("home.attention.overdue")) }).click();
  expect(await page.locator("tbody tr[data-id]").count()).toBe(1);

  await page.getByRole("complementary", { name: t("home.inbox.record.title") }).getByRole("button").first().focus();
  await page.keyboard.press("Escape");
  expect(await page.locator('[data-pane="record"]').count()).toBe(0);
});
