// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { t } from "@console/i18n";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await mountGalleryEntry({
    name: "phone-bars",
    entryPath: "/apps/web/src/ui/phone-bars/phone-bars.gallery.tsx",
    readySelector: "[data-phone-bars-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("PhoneTopBar and PhoneBottomNav pass WCAG 2.2 AA axe checks, meet 52px/56px/44px geometry, and open overflow", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page, [1440, 390], 844)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = "light";
  });

  const overflowDemo = page.locator("[data-phone-bars-demo='overflow']");
  const geometry = await overflowDemo.evaluate(root => {
    const header = root.querySelector("header")!;
    const back = header.querySelector("a")!;
    const nav = root.querySelector("nav")!;
    return {
      topHeight: Math.round(header.getBoundingClientRect().height),
      backWidth: Math.round(back.getBoundingClientRect().width),
      backHeight: Math.round(back.getBoundingClientRect().height),
      bottomHeight: Math.round(nav.getBoundingClientRect().height),
    };
  });
  expect(geometry.topHeight).toBe(52);
  expect(geometry.backWidth).toBe(44);
  expect(geometry.backHeight).toBe(44);
  expect(geometry.bottomHeight).toBeGreaterThanOrEqual(56);

  await overflowDemo.getByRole("button", { name: t("shell.nav.more") }).click();
  await overflowDemo.getByRole("link", { name: t("shell.link.org") }).click();
  await expect
    .poll(async () => await overflowDemo.getByRole("button", { name: t("shell.nav.more") }).getAttribute("data-active"))
    .toBe("true");
});
