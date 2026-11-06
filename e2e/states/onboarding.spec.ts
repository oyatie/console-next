// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockOnboarding } from "../mock/onboarding";
import { onboardingScreens, type OnboardingState } from "./onboarding";
import * as registry from "./registry";

test.beforeAll(() => loadCatalog("ko"));

test("onboarding routes expose the executable state matrix", () => {
  expect(registry).toHaveProperty("onboardingScreens", onboardingScreens);
});

for (const screen of onboardingScreens) for (const state of Object.keys(screen.states) as OnboardingState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }, info) => {
    info.annotations.push({ type: "route", description: screen.path }, { type: "state", description: state });
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await mockOnboarding(page, screen, state);
    const empty = () => screen.key === "setup-go-live"
      ? page.getByRole("main").getByRole("heading", { name: t("setup.golive.blockers"), exact: true })
      : screen.key === "setup-org" ? page.getByRole("main").locator("#first-run-title")
      : page.getByRole("main").getByRole("link", { name: t("entity.empty.action"), exact: true });
    try {
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === screen.read);
      await page.goto(screen.path);
      await requested;
      await expect(page).toHaveURL(new RegExp(`${screen.destination.replace("?", "\\?")}$`));
      const main = page.getByRole("main");
      if (state === "loading") {
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
        await expect(empty()).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByRole("alert").first()).toContainText(t("common.loadFailed.title"), { timeout: 20_000 });
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(1);
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
        await expect(empty()).toHaveCount(0);
      } else {
        await expect(empty()).toBeVisible();
        if (screen.key === "setup-go-live") {
          await expect(main.getByRole("button", { name: t("setup.golive.start"), exact: true })).toHaveAttribute("aria-disabled", "true");
          await expect(main.getByText(t("setup.golive.item.terms_not_accepted"), { exact: true })).toBeVisible();
        }
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await fits(page, `${screen.key}/${state}/${width}/${theme}`);
        await page.screenshot({ path: info.outputPath(`${state}-${width}-${theme}.png`), fullPage: true });
      }
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      await info.attach("screen-state", { contentType: "application/json", body: JSON.stringify({
        kind: "screen-state", route: screen.path, state, status: "pass", viewport: width,
      }) });
      if (state === "loading" || state === "failed") {
        const attempts = fixture.attempts();
        fixture.recover();
        if (state === "failed") await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
        await expect(empty()).toBeVisible();
        if (state === "failed") expect(fixture.attempts()).toBeGreaterThan(attempts);
        await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
      }
      expect(errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
