// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe } from "../a11y";
import { accountSecurityReads } from "../mock/account-security";
import { failure } from "../mock/fixtures";
import { accountSecurityScreens, type AccountSecurityState } from "./account-security";

test.beforeAll(() => loadCatalog("ko"));
for (const screen of accountSecurityScreens) for (const state of Object.keys(screen.states) as AccountSecurityState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const f = await accountSecurityReads(page, screen, state);
    try {
      await page.goto(screen.key === "login" ? `${screen.path}?enrolled=true` : screen.path);
      const main = page.getByRole("main");
      if (screen.key === "login") {
        await main.getByText(t("auth.login.or"), { exact: true }).click();
        await main.getByRole("textbox", { name: t("auth.login.code"), exact: true }).fill("ABCD-EFGH");
        await main.getByRole("button", { name: t("auth.login.submitCode"), exact: true }).click();
      }
      await expect.poll(f.attempts).toBeGreaterThan(0);
      if (state === "loading") {
        await expect(screen.key === "login" ? main.getByRole("status").filter({ hasText: t("auth.login.pending") }) : main.getByRole("status", { name: t("common.loading"), exact: true })).toBeVisible();
        if (screen.key !== "login") await expect(main.locator("[data-bone]").first().locator("..")).toHaveCSS("opacity", "1");
        if (screen.key === "login") for (const name of ["auth.login.continue", "auth.login.passkey", "auth.login.submitCode"] as const) {
          await expect(main.getByRole("button", { name: t(name), exact: true })).toBeDisabled();
        }
        if (screen.key === "login") {
          await expect(main.getByRole("status")).toHaveCount(1);
          await expect(main.getByText(t("auth.login.enrolled"), { exact: true })).toHaveCount(0);
        }
      } else if (screen.key === "login") {
        await expect(main.getByRole("alert")).toContainText(t("auth.login.codeRejected"));
        await expect(main.getByRole("button", { name: t("auth.login.submitCode"), exact: true })).toBeEnabled();
        await expect(main.getByRole("textbox", { name: t("auth.login.code"), exact: true })).toHaveValue("ABCD-EFGH");
      } else {
        await expect(main.getByRole("alert")).toContainText(t("setup.error.terms_not_published"));
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeEnabled();
      }
      if (screen.key === "setup-passkey" && state !== "loading") {
        await expect(main.getByRole("button", { name: t("auth.setup.consent.continue"), exact: true })).toBeDisabled();
        for (const checkbox of await main.getByRole("checkbox").all()) await expect(checkbox).toBeDisabled();
        await expect(main.getByRole("button", { name: t("shell.logout"), exact: true })).toBeEnabled();
      }
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
        await test.info().attach(`${screen.key}-${state}-${width}-${theme}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      }
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(f.unexpected).toEqual([]);
      const observation = await main.evaluate((el, raw) => ({
        support_ref: el.querySelector("[data-support-reference]")?.getAttribute("data-support-reference") ?? null,
        reference_count: el.querySelectorAll("[data-support-reference]").length,
        raw_server_text: el.textContent?.includes(raw) ?? false,
        floorplan: el.getAttribute("data-floorplan") ?? el.querySelector("[data-floorplan]")?.getAttribute("data-floorplan") ?? null,
      }), failure("terms_not_published").error.message);
      await test.info().attach("screen-state", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        ...observation, route: screen.path, state, width, status: "pass",
      })) });
      if (state === "loading") {
        const pending = screen.key === "login" ? await main.getByRole("status").elementHandle() : null;
        f.release();
        await expect(main.getByRole("alert")).toBeVisible();
        if (pending) expect(await pending.evaluate(el => el.isConnected)).toBe(false);
      }
    } finally {
      await page.close();
      f.release();
    }
  });
}
