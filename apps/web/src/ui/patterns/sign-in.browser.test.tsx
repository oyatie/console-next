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

// One panel whose top edge never moves: a screen that grows (documents arriving, a notice) grows downward.
test.each([[1280, 800], [390, 844]])("the Console panel keeps its top edge while its content grows at %spx", async (width, height) => {
  const { page } = mounted;
  await setConsoleViewport(page, width, height);
  const card = page.locator('[data-pattern="sign-in"] > div').first();
  const top = await card.evaluate(el => el.getBoundingClientRect().top);
  await card.evaluate(el => { const grow = document.createElement("div"); grow.dataset.grow = ""; grow.style.height = "300px"; el.append(grow); });
  try {
    expect(await card.evaluate(el => el.getBoundingClientRect().top)).toBe(top);
  } finally {
    await page.evaluate(() => document.querySelector("[data-grow]")?.remove());
  }
});

// The boards hold that edge at 200 px. A short window (a laptop zoomed to 150 %) cannot keep it there and still show
// the panel's actions, so the edge comes up with the window instead of pushing them below the fold.
test("the Console panel keeps the board's top edge and comes up on a short window", async () => {
  const { page } = mounted;
  const card = page.locator('[data-pattern="sign-in"] > div').first();
  await setConsoleViewport(page, 1440, 900);
  expect(await card.evaluate(el => el.getBoundingClientRect().top)).toBe(200);
  await setConsoleViewport(page, 1024, 520);
  expect(await card.evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(520);
});
