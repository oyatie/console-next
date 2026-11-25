// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe } from "../a11y";
import { accountSecurityReads } from "../mock/account-security";
import { failure } from "../mock/fixtures";
import { accountSecurityScreens, type AccountSecurityState } from "./account-security";

test.beforeAll(() => loadCatalog("ko"));
for (const screen of accountSecurityScreens) for (const state of Object.keys(screen.states) as AccountSecurityState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px${state === "pending" ? "" : " @ui-state"}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const f = await accountSecurityReads(page, screen, state);
    let observed = false;
    try {
      await page.goto(screen.key === "login" ? `${screen.path}?enrolled=true` : screen.path);
      const main = page.getByRole("main");
      // Whichever style draws it, the card that holds the code sign-in is marked busy while it waits.
      const busy = main.locator('[aria-busy="true"]', { has: page.getByRole("button", { name: t("auth.login.submitCode"), exact: true }) });
      if (screen.key === "setup-passkey" && state === "refused") {
        await expect(page).toHaveURL(/\/login$/);
        await expect(main.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
      } else {
        let before: number | undefined;
        const submit = main.getByRole("button", { name: t("auth.login.submitCode"), exact: true });
        const codeField = main.getByRole("textbox", { name: t("auth.login.code"), exact: true });
        if (screen.key === "login") {
          await main.getByText(t("auth.login.or"), { exact: true }).click();
          await codeField.fill("ABCDE-FGHJK");
          await page.evaluate(() => document.fonts.ready);
          before = (await submit.boundingBox())!.y;
          await codeField.press("Enter");
        }
        await expect.poll(f.attempts).toBeGreaterThan(0);
        if (state === "pending") {
          await expect(page.getByRole("status").filter({ hasText: t("auth.login.pending") })).toHaveClass("sr-only");
          await expect(busy).toHaveCount(1);
          for (const control of await main.locator("button").all()) await expect(control).toBeDisabled();
          for (const input of await main.locator("input").all()) await expect(input).not.toBeEditable();
          await expect(codeField).toBeFocused();
          await expect(main.getByText(t("auth.login.enrolled"), { exact: true })).toBeVisible();
          expect((await submit.boundingBox())!.y - before!).toBe(0);
        } else if (state === "loading") {
          await expect(main.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
          await expect(main.locator("[data-bone]").first().locator("..")).toHaveCSS("opacity", "1");
        } else if (screen.key === "login") {
          await expect(main.getByRole("alert")).toHaveAttribute("data-tone", "danger");
          await expect(main.getByRole("alert")).toContainText(t("auth.login.codeRejected"));
          await expect(busy).toHaveCount(0);
          await expect(main.getByRole("button", { name: t("auth.login.submitCode"), exact: true })).toBeEnabled();
          await expect(codeField).toHaveValue("ABCDE-FGHJK");
          await expect(codeField).toBeFocused();
        } else {
          await expect(main.getByRole("alert")).toContainText(t("setup.error.terms_not_published"));
          await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeEnabled();
        }
        if (screen.key === "setup-passkey" && state !== "loading") {
          await expect(main.getByRole("button", { name: t("auth.setup.consent.continue"), exact: true })).toBeDisabled();
          for (const checkbox of await main.getByRole("checkbox").all()) await expect(checkbox).toBeDisabled();
          await expect(main.getByRole("button", { name: t("shell.logout"), exact: true })).toBeEnabled();
        }
      }
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
        await test.info().attach(`${screen.key}-${state}-${width}-${theme}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      }
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(f.unexpected).toEqual([]);
      observed = true;
      if (state === "loading" || state === "pending") {
        f.release();
        await expect(main.getByRole("alert")).toBeVisible();
        if (state === "pending") {
          await expect(busy).toHaveCount(0);
          await expect(main.getByRole("textbox", { name: t("auth.login.code"), exact: true })).toBeFocused();
        }
      }
    } finally {
      try {
        const observation = await page.getByRole("main").evaluate((el, raw) => {
          const refs = el.querySelectorAll("[data-support-reference]");
          return { support_ref: refs.length === 1 ? refs[0]!.getAttribute("data-support-reference") : null,
            reference_count: refs.length, raw_server_text: el.textContent?.includes(raw) ?? false, floorplan: null };
        }, failure("terms_not_published").error.message);
        await info.attach(state === "pending" ? "command-state" : "screen-state", { contentType: "application/json", body: Buffer.from(JSON.stringify({
          ...observation, route: screen.path, state, width, status: observed ? "pass" : "unknown",
        })) });
      } finally { await page.close(); f.release(); }
    }
  });
}
