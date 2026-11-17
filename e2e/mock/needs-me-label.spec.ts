// SPDX-License-Identifier: LicenseRef-Proprietary
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { bootEn, bootKo } from "../../packages/i18n/src/catalogs/boot";
import { breakpoints } from "../../apps/web/src/ui/breakpoints";
import { MAX_RETRY_AFTER_MS } from "../../apps/web/src/lib/react/query-defaults";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { failure, inbox } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

for (const locale of ["ko", "en"] as const) for (const width of [1440, 1024, 390]) {
  for (const state of ["loading", "zero", "one", "many", "inexact", "failed", "refused"] as const) {
    test(`inbox accessible name includes its label: ${locale}, ${width}px, ${state}`, async ({ page }) => {
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
        const trigger = page.locator("#top-needs-me");
        const title = locale === "ko" ? "업무함" : "Inbox";
        const counted = state === "one" || state === "many" || state === "inexact";
        if (counted) {
          await expect.soft(trigger).toHaveAccessibleName(`${title} ${count}${state === "inexact" ? "+" : ""}`);
          await expect.soft(trigger).toHaveAccessibleDescription(locale === "ko" ? `업무함 ${count.toLocaleString(locale)}건${state === "inexact" ? " 이상" : ""}`
            : state === "inexact" ? `Inbox · at least ${count.toLocaleString(locale)} items need my action` : `Inbox · ${count} ${count === 1 ? "item needs" : "items need"} my action`);
          await expect(trigger.locator("[data-count]")).toHaveText(`${count}${state === "inexact" ? "+" : ""}`);
        } else {
          await expect(trigger).toHaveAccessibleName(state === "zero" ? title
            : new RegExp(`^${title}\\s.*(?:${state === "loading" ? "불러오는 중|loading" : "확인 불가|count unavailable"})`));
          await expect(trigger.locator("[data-count]")).toHaveCount(0);
        }
        await expect(trigger.getByText(title, { exact: true })).toBeVisible({ visible: width >= breakpoints.xl });
        for (const theme of ["light", "dark"]) {
          await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
          const scan = await new AxeBuilder({ page }).include(".top").withRules(["label-content-name-mismatch", "button-name"]).analyze();
          expect.soft(scan.violations, `${theme} header label in name`).toEqual([]);
        }
        const jump = page.locator(".top__jump");
        await expect(jump).toHaveAccessibleName((locale === "ko" ? bootKo : bootEn)[width === 1440 ? "shell.jump" : "shell.jumpLabel"]);
        await expectAxe(page, `inbox label ${locale} ${width} ${state}`, { include: ".top" });
        await fits(page, `inbox label ${locale} ${width} ${state}`);
        expect(mock.unexpected).toEqual([]);
      } finally { release(); }
    });
  }
}
