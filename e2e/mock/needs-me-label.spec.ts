// SPDX-License-Identifier: LicenseRef-Proprietary
import { shell, shellSelectors } from "../shell";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { breakpoints } from "../../apps/web/src/ui/breakpoints";
import { MAX_RETRY_AFTER_MS } from "../../apps/web/src/lib/react/query-defaults";
import { expectAxe, fits } from "../a11y";
import { experienceState } from "../experience";
import { test } from "../locale-fixture";
import { screens } from "../states/registry";
import { failure, inbox } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

/** The bar's to-do entry as e2e/shell.ts needsMe finds it, with Console's navigation named in the page's language. */
const todo = (page: Page) => page.locator("#top-needs-me")
  .or(page.locator('html[data-experience="console"]').getByRole("navigation", { name: t("shell.nav"), exact: true }).locator('a[href="/"]'));

async function openPeople(page: Page, locale: "ko" | "en", width: number) {
  await loadCatalog(locale);
  i18n.set(locale);
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
  const mock = await mockScreen(page, screens[0], "populated");
  await page.goto("/people");
  await expect(page.locator("main h1").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  return mock;
}

for (const locale of ["ko", "en"] as const) for (const width of [1440, 1024, 390]) {
  for (const state of ["loading", "zero", "one", "many", "inexact", "failed", "refused"] as const) {
    test(`inbox accessible name includes its label: ${locale}, ${width}px, ${state}`, async ({ page }) => {
      await loadCatalog(locale);
      i18n.set(locale);
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
      const mock = await mockScreen(page, screens[0], "populated");
      const count = state === "zero" ? 0 : state === "one" ? 1 : state === "inexact" ? 1234 : 3;
      const queue = inbox(Math.min(count, 3));
      queue.counts.turn = { total: count, total_is_exact: state !== "inexact" };
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await mockRoute(page, "get", "/api/v1/me/action-inbox", async () => {
        if (state === "loading") await held;
        // A Retry-After beyond the automatic retry window makes the unavailable state immediate.
        return state === "failed" ? { status: 503, json: failure("service_unavailable"), headers: { "retry-after": String(Math.ceil(MAX_RETRY_AFTER_MS / 1000) + 1) } }
          : state === "refused" ? { status: 403, json: failure("forbidden") } : { status: 200, json: queue };
      });
      try {
        await page.goto("/people");
        await expect(page.locator("main h1").first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const trigger = todo(page);
        const title = t("home.inbox.title");
        const counted = state === "one" || state === "many" || state === "inexact";
        if (counted) {
          await expect.soft(trigger).toHaveAccessibleName(`${title} ${count}${state === "inexact" ? "+" : ""}`);
          await expect.soft(trigger).toHaveAccessibleDescription(t(state === "inexact" ? "shell.needsMe.countMoreDescription" : "shell.needsMe.countDescription", { count }));
          await expect(trigger.locator("[data-count]")).toHaveText(`${count}${state === "inexact" ? "+" : ""}`);
        } else {
          await expect(trigger).toHaveAccessibleName(state === "zero" ? title
            : new RegExp(`^${title}\\s.*(?:${state === "loading" ? "불러오는 중|loading" : "확인 불가|count unavailable"})`));
          // Classic marks its count [data-count]; Console's badge is a <data>.
          await expect(trigger.locator("[data-count], data")).toHaveCount(0);
        }
        for (const theme of ["light", "dark"]) {
          await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
          const scan = await new AxeBuilder({ page }).include(shellSelectors().banner).withRules(["label-content-name-mismatch", "button-name"]).analyze();
          expect.soft(scan.violations, `${theme} header label in name`).toEqual([]);
        }
        await expectAxe(page, `inbox label ${locale} ${width} ${state}`, { include: shellSelectors().banner });
        await fits(page, `inbox label ${locale} ${width} ${state}`);
        expect(mock.unexpected).toEqual([]);
      } finally { release(); }
    });
  }
}

// Classic shows the to-do label from xl up, and below 1440 names its search by the shorter prompt it shows there.
for (const locale of ["ko", "en"] as const) for (const width of [1440, 1024, 390]) {
  test(`header shows the inbox label and search name for its width: ${locale}, ${width}px @baseline`, async ({ page }) => {
    const mock = await openPeople(page, locale, width);
    await expect(todo(page).getByText(t("home.inbox.title"), { exact: true })).toBeVisible({ visible: width >= breakpoints.xl });
    await expect(shell(page).search).toHaveAccessibleName(t(width === 1440 ? "shell.jump" : "shell.jumpLabel"));
    expect(mock.unexpected).toEqual([]);
  });
}

// d-home.dc.html:34 draws Console's to-do link with its label at 1440; 1024 has no board and pins the render. No board
// draws an admin's bar at 390, so it is held to the invariants above. The search name is not pinned: Console's search
// fails label-in-name above (its hint is not in its name), so the render is not yet the target.
test.describe("console bar", () => {
  test.use({ storageState: experienceState("console") });
  for (const locale of ["ko", "en"] as const) for (const width of [1440, 1024]) {
    test(`console bar shows the inbox label: ${locale}, ${width}px`, async ({ page }) => {
      const mock = await openPeople(page, locale, width);
      await expect(todo(page).getByText(t("home.inbox.title"), { exact: true })).toBeVisible();
      expect(mock.unexpected).toEqual([]);
    });
  }
});
