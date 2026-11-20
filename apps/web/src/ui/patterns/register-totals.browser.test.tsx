// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { MountedGallery } from "../../lib/gallery-browser-test";
import { expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("register-totals");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("RegisterTotals passes WCAG 2.2 AA matrix, filters register rows, and updates Ledger preview", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);

  await setConsoleViewport(page, 1440, 900);
  await page.locator('tbody tr[data-id="10416"]').click();
  expect(await page.locator('[data-pattern="register-totals"]').textContent()).toContain("2,559,000");

  await page.getByRole("button", { name: new RegExp(tg("pat.reg.bankHold")) }).click();
  expect(await page.locator("tbody tr[data-id]").count()).toBe(1);
}, 45_000);
