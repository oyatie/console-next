// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  await loadCatalog("ko");
  mounted = await mountGalleryEntry({
    name: "decision-pane",
    entryPath: "/apps/web/src/ui/decision-pane/decision-pane.gallery.tsx",
    readySelector: "[data-decision-pane-gallery]",
  });
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("DecisionPane passes WCAG 2.2 AA axe checks, requires a comment on reject while allowing empty approve", async () => {
  const { page } = mounted;
  expect(await scanWcag22Matrix(page)).toEqual([]);

  await page.getByRole("button", { name: t("uiWorklist.reject"), exact: true }).click();
  const alert = page.locator('[data-decision-pane] [role="alert"]');
  expect(await alert.textContent()).toContain(t("uiWorklist.opinionRequired"));

  await page.getByRole("button", { name: t("uiWorklist.approve"), exact: true }).click();
  expect(await page.locator("[data-decision-pane-gallery]").getAttribute("data-outcome")).toBe("approved");

  await page.locator("[data-decision-pane] input").fill("Memo");
  await page.getByRole("button", { name: t("uiWorklist.reject"), exact: true }).click();
  expect(await page.locator("[data-decision-pane-gallery]").getAttribute("data-outcome")).toBe("rejected");
});
