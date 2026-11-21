// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { expectAxe, fits } from "../a11y";
import { routeReady } from "../flows";
import { withFullPage } from "../shots";
import { forgetResize } from "../stability";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

const SHOTS_DIR = process.env.STRUCT_SHOTS;

const SHELL_PATTERNS = [
  { id: "wizard", refusedRef: "wizard-refusal" },
  { id: "settings", refusedRef: "settings-refusal" },
  { id: "canvas", refusedRef: "canvas-refusal" },
] as const;

async function assertCanvas390RealViewport(page: import("@playwright/test").Page, navLabel: string) {
  await expect
    .poll(
      async () =>
        page.evaluate(expectedNavLabel => {
          const main = document.querySelector<HTMLElement>("main");
          const foot = document.querySelector<HTMLElement>('[class*="canvasFoot"]');
          const nav = document.querySelector<HTMLElement>(`nav[aria-label="${CSS.escape(expectedNavLabel)}"]`);
          const vp = document.querySelector<HTMLElement>('[data-pattern="canvas"] section > div');
          const zoom = document.querySelector<HTMLElement>('[data-pattern="canvas"] [role="group"]');
          if (!main || !foot || !nav || !vp || !zoom) return { ready: false };
          const mainRect = main.getBoundingClientRect();
          const footRect = foot.getBoundingClientRect();
          const navRect = nav.getBoundingClientRect();
          const vpRect = vp.getBoundingClientRect();
          const zoomRect = zoom.getBoundingClientRect();
          const nodes = [...document.querySelectorAll<HTMLElement>('[id^="node-"]')].map(el => {
            const r = el.getBoundingClientRect();
            return {
              id: el.id,
              insideVp:
                r.left >= vpRect.left - 0.5 &&
                r.right <= vpRect.right + 0.5 &&
                r.top >= vpRect.top - 0.5 &&
                r.bottom <= vpRect.bottom + 0.5,
              overlapsZoom: r.left < zoomRect.right && r.right > zoomRect.left && r.top < zoomRect.bottom && r.bottom > zoomRect.top,
              overlapsFoot: r.left < footRect.right && r.right > footRect.left && r.top < footRect.bottom && r.bottom > footRect.top,
            };
          });
          return {
            ready: true,
            mainScrollH: main.scrollHeight,
            mainClientH: main.clientHeight,
            footBottom: footRect.bottom,
            mainBottom: mainRect.bottom,
            navTop: navRect.top,
            nodeCount: nodes.length,
            allInside: nodes.every(n => n.insideVp),
            noneOverlapsZoom: nodes.every(n => !n.overlapsZoom),
            noneOverlapsFoot: nodes.every(n => !n.overlapsFoot),
          };
        }, navLabel),
      { timeout: 5000 },
    )
    .toMatchObject({
      ready: true,
      nodeCount: 4,
      allInside: true,
      noneOverlapsZoom: true,
      noneOverlapsFoot: true,
    });

  const geom = await page.evaluate(expectedNavLabel => {
    const main = document.querySelector<HTMLElement>("main")!;
    const foot = document.querySelector<HTMLElement>('[class*="canvasFoot"]')!;
    const nav = document.querySelector<HTMLElement>(`nav[aria-label="${CSS.escape(expectedNavLabel)}"]`)!;
    return {
      mainScrollH: main.scrollHeight,
      mainClientH: main.clientHeight,
      footBottom: foot.getBoundingClientRect().bottom,
      mainBottom: main.getBoundingClientRect().bottom,
      navTop: nav.getBoundingClientRect().top,
    };
  }, navLabel);
  expect(geom.mainScrollH).toBeLessThanOrEqual(geom.mainClientH);
  expect(geom.footBottom).toBeLessThanOrEqual(geom.mainBottom + 0.5);
  expect(geom.footBottom).toBeLessThanOrEqual(geom.navTop + 0.5);
}

test.beforeAll(() => loadCatalog("ko"));

for (const { id, refusedRef } of SHELL_PATTERNS) {
  test(`pattern ${id} renders in Console mode across 1440/390 light/dark and refused state with zero axe or overflow issues`, async ({
    page,
  }) => {
    if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });
    await page.addInitScript(
      ({ expKey }) => {
        localStorage.setItem(expKey, "console");
        localStorage.setItem("console.theme", "light");
      },
      { expKey: EXPERIENCE_KEY },
    );

    const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "populated");
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/_review/patterns/${id}`);
      const root = page.locator(`[data-pattern="${id}"]`);
      await expect(root).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-experience", "console");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

      for (const width of [1440, 390] as const) {
        const height = width === 1440 ? 900 : 844;
        await page.setViewportSize({ width, height });
        await forgetResize(page);
        await fits(page, `${id} console ${width}`);
        let lightSurface = "";
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate(mode => {
            localStorage.setItem("console.theme", mode);
            document.documentElement.dataset.theme = mode;
          }, theme);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await page.waitForFunction(
            ({ mode, prevLight }) => {
              const rootStyle = getComputedStyle(document.documentElement);
              const pat = document.querySelector("[data-pattern]");
              const patBg = pat ? getComputedStyle(pat).backgroundColor : "";
              if (rootStyle.colorScheme !== mode || !patBg) return false;
              return mode === "light" ? true : patBg !== prevLight;
            },
            { mode: theme, prevLight: lightSurface },
          );
          if (theme === "light") {
            lightSurface = await root.evaluate(el => getComputedStyle(el).backgroundColor);
          }
          await expectAxe(page, `${id} console ${width} ${theme}`);
          if (id === "canvas" && width === 390) {
            await assertCanvas390RealViewport(page, t("shell.nav"));
            if (SHOTS_DIR) {
              await page.screenshot({
                path: path.join(SHOTS_DIR, `${id}--390-viewport-${theme}.png`),
                fullPage: false,
              });
            }
          }
          if (SHOTS_DIR) {
            await withFullPage(page, () =>
              page.screenshot({
                path: path.join(SHOTS_DIR, `${id}--${width}-${theme}.png`),
                fullPage: true,
              }),
            );
          }
        }
      }

      if (id === "canvas") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/_review/patterns/${id}`);
        await expect(root).toBeVisible();
        await forgetResize(page);
        await assertCanvas390RealViewport(page, t("shell.nav"));
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/_review/patterns/${id}?state=refused`);
      const main = page.getByRole("main");
      await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
      await expect(main).toContainText(refusedRef);
      await expect(main.getByRole("heading", { level: 1 })).toHaveCount(1);
      await fits(page, `${id} refused 390`);
      await expectAxe(page, `${id} refused 390`);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      fixture.release();
    }
  });
}

test("pattern sign-in renders standalone outside the shell across 1440/390 light/dark, refused, and loading states", async ({
  page,
}) => {
  if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });
  await page.addInitScript(
    ({ expKey }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", "light");
    },
    { expKey: EXPERIENCE_KEY },
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/_review/patterns/sign-in");
  const root = page.locator('[data-pattern="sign-in"]');
  await expect(root).toBeVisible();
  await expect(page.locator("[data-console-shell]")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-experience", "console");

  for (const width of [1440, 390] as const) {
    const height = width === 1440 ? 900 : 844;
    await page.setViewportSize({ width, height });
    await forgetResize(page);
    await fits(page, `sign-in console ${width}`);
    let lightSurface = "";
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(mode => {
        localStorage.setItem("console.theme", mode);
        document.documentElement.dataset.theme = mode;
      }, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.waitForFunction(
        ({ mode, prevLight }) => {
          const rootStyle = getComputedStyle(document.documentElement);
          const pat = document.querySelector('[data-pattern="sign-in"]');
          const patBg = pat ? getComputedStyle(pat).backgroundColor : "";
          if (rootStyle.colorScheme !== mode || !patBg) return false;
          return mode === "light" ? true : patBg !== prevLight;
        },
        { mode: theme, prevLight: lightSurface },
      );
      if (theme === "light") {
        lightSurface = await root.evaluate(el => getComputedStyle(el).backgroundColor);
      }
      await expectAxe(page, `sign-in console ${width} ${theme}`);
      if (SHOTS_DIR) {
        await withFullPage(page, () =>
          page.screenshot({
            path: path.join(SHOTS_DIR, `sign-in--${width}-${theme}.png`),
            fullPage: true,
          }),
        );
      }
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/_review/patterns/sign-in?state=refused");
  await expect(page.locator("[data-console-shell]")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("sign-in-refusal");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveCount(1);
  await fits(page, "sign-in refused 390");
  await expectAxe(page, "sign-in refused 390");

  await page.goto("/_review/patterns/sign-in?state=loading");
  await expect(page.locator("[data-console-shell]")).toHaveCount(0);
  const loadingRegion = page.getByRole("status", { name: tg("pat.signIn.loading") });
  await expect(loadingRegion).toBeVisible();
  await expect(loadingRegion).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-pattern="sign-in"] :is(button, input, a[href], summary)')).toHaveCount(0);
  await fits(page, "sign-in loading 390");
  await expectAxe(page, "sign-in loading 390");
});

test("patterns P8-P11 support keyboard journeys and preserve baseline parity", async ({ page }) => {
  await page.addInitScript(
    ({ expKey }) => {
      localStorage.setItem(expKey, "console");
      localStorage.setItem("console.theme", "light");
    },
    { expKey: EXPERIENCE_KEY },
  );

  const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "populated");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });

    // Wizard keyboard/step progression
    await page.goto("/_review/patterns/wizard");
    await page.getByRole("button", { name: tg("pat.wizard.next"), exact: true }).click();
    await page.getByRole("button", { name: tg("pat.wizard.next"), exact: true }).click();
    await page.getByRole("button", { name: tg("pat.wizard.commit"), exact: true }).click();
    await expect(page.getByText(tg("pat.wizard.submitted"))).toBeVisible();

    // Settings inspector Escape focus restore
    await page.goto("/_review/patterns/settings");
    const inspectBtn = page.locator("#settings-inspect-btn");
    await inspectBtn.click();
    const recordPane = page.locator('[data-pane="record"]');
    await expect(recordPane).toBeVisible();
    await recordPane.getByRole("button").first().focus();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-pane="record"]')).toHaveCount(0);
    await expect(inspectBtn).toBeFocused();

    // Canvas arrow-key navigation + Enter + Escape focus restore
    await page.goto("/_review/patterns/canvas");
    await routeReady(page);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
    await page.locator("#node-root").focus();
    await expect(page.locator("#node-root")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#node-entity")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-pane="record"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-pane="record"]')).toHaveCount(0);
    await expect(page.locator("#node-entity")).toBeFocused();

    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("patterns P8-P11 preserve baseline layout and axe cleanliness when Console is off", async ({ page }) => {
  const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "populated");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const id of ["wizard", "settings", "canvas", "sign-in"] as const) {
      await page.goto(`/_review/patterns/${id}`);
      await expect(page.locator(`[data-pattern="${id}"]`)).toBeVisible();
      await expect(page.locator("html")).not.toHaveAttribute("data-experience", "console");
      await fits(page, `${id} baseline 1440`);
      await expectAxe(page, `${id} baseline 1440`);
    }
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
