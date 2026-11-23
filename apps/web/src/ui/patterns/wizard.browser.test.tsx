// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";
import type { MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("wizard");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Wizard pattern passes WCAG 2.2 AA matrix, fits 390px and 320px, and advances/completes steps cleanly", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);
  await expectFitsViewport(page, 320);

  await setConsoleViewport(page, 1440, 900);
  const stepList = page.getByRole("list", { name: tg("pat.wizard.stepsLabel") });
  expect(await stepList.locator('[aria-current="step"]').textContent()).toContain(tg("pat.wizard.stepBasics"));

  await page.getByRole("button", { name: tg("pat.wizard.next"), exact: true }).click();
  expect(await stepList.locator('[aria-current="step"]').textContent()).toContain(tg("pat.wizard.stepCert"));

  await page.getByRole("button", { name: tg("pat.wizard.back"), exact: true }).click();
  expect(await stepList.locator('[aria-current="step"]').textContent()).toContain(tg("pat.wizard.stepBasics"));

  await page.getByRole("button", { name: tg("pat.wizard.next"), exact: true }).click();
  await page.getByRole("button", { name: tg("pat.wizard.next"), exact: true }).click();
  expect(await stepList.locator('[aria-current="step"]').textContent()).toContain(tg("pat.wizard.stepReview"));

  const commit = page.getByRole("button", { name: tg("pat.wizard.commit"), exact: true });
  await commit.click();
  expect(await commit.getAttribute("data-submitted")).toBe("1");
  await page.getByText(tg("pat.wizard.submitted")).waitFor();
}, 45_000);
