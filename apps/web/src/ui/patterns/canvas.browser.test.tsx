// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";
import type { MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("canvas");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Canvas pattern passes WCAG 2.2 AA matrix, fits 390px and 320px, zooms OrgCanvas, and supports keyboard tree navigation + Escape focus restore", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);
  await expectFitsViewport(page, 320);

  await setConsoleViewport(page, 1440, 900);
  const zoomLive = page.locator('[role="group"][aria-label="' + t("uiOrgCanvas.zoom") + '"] [aria-live="polite"]');
  const initialZoom = await zoomLive.textContent();
  await page.getByRole("button", { name: t("uiOrgCanvas.zoomIn"), exact: true }).click();
  expect(await zoomLive.textContent()).not.toBe(initialZoom);
  await page.getByRole("button", { name: t("uiOrgCanvas.fit"), exact: true }).click();
  expect(await zoomLive.textContent()).toBe(initialZoom);

  const rootNode = page.locator("#node-root");
  await rootNode.focus();
  await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("node-entity");
  await page.keyboard.press("Enter");
  await page.locator('[data-pane="record"]').waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-pane="record"]'));
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("node-entity");
}, 45_000);
