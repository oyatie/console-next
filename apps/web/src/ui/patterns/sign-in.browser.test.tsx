// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";
import type { MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("sign-in");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("SignIn pattern passes WCAG 2.2 AA matrix, fits 390px and 320px, renders outside shell, and updates background across light/dark themes", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);
  await expectFitsViewport(page, 320);

  expect(await page.locator("[data-console-shell]").count()).toBe(0);
  expect(await page.locator("h1").count()).toBe(1);

  await setConsoleViewport(page, 1440, 900, "light");
  const lightBg = await page.locator('[data-pattern="sign-in"]').evaluate(el => getComputedStyle(el).backgroundColor);
  await setConsoleViewport(page, 1440, 900, "dark");
  const darkBg = await page.locator('[data-pattern="sign-in"]').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(darkBg).not.toBe(lightBg);

  await page.getByText(tg("pat.signIn.codeSummary")).click();
  await page.getByRole("button", { name: tg("pat.signIn.codeSubmit"), exact: true }).waitFor();
}, 45_000);
