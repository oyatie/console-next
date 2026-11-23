// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { MountedGallery } from "../../lib/gallery-browser-test";
import { expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("record");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Record pattern passes WCAG 2.2 AA matrix, navigates SecNav, and manages overlay sheet", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);
  await setConsoleViewport(page, 1440, 900);

  const personalLink = page.locator('nav a[href="#sec-personal"]');
  await personalLink.click();
  expect(await personalLink.getAttribute("aria-current")).toBe("true");

  await page.getByRole("button", { name: t("uiRecord.edit"), exact: true }).click();
  await page.getByRole("dialog").waitFor();
  expect(await page.getByRole("dialog").count()).toBe(1);
  await page.keyboard.press("Escape");
  expect(await page.getByRole("dialog").count()).toBe(0);
}, 45_000);
