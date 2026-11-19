// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe } from "../a11y";
import { accountSecurityPasskey } from "../mock/account-security";
import { authz, token, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";

test.beforeAll(() => loadCatalog("ko"));
for (const mode of ["login", "autofill", "enroll", "reauth"] as const) for (const width of [1440, 390]) {
  test(`${mode}: passkey pending stays in place at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await accountSecurityPasskey(page, mode);
    try {
      await page.goto(mode === "enroll" ? "/setup-passkey" : mode === "reauth" ? "/account" : "/login?enrolled=true");
      if (mode === "reauth") {
        await expect(page.getByRole("heading", { name: t("account.title"), exact: true })).toBeVisible();
        await page.evaluate(previous => {
          const channel = new BroadcastChannel("console.session");
          channel.postMessage({ principal: null, previous });
          channel.close();
        }, JSON.stringify([authz.org_id, user.id]));
      }
      const region = mode === "reauth" ? page.getByRole("dialog") : page.getByRole("main");
      const container = region.locator(mode === "enroll" ? ".auth__content" : mode === "reauth" ? ".dialog__body" : ".auth__card").last();
      const button = region.getByRole("button", { name: t(mode === "enroll" ? "auth.setup.register" : mode === "reauth" ? "idle.reauth.signIn" : "auth.login.passkey"), exact: true });
      const idField = region.getByRole("textbox", { name: t("auth.login.id"), exact: true });
      await expect(button).toBeEnabled();
      await page.evaluate(() => document.fonts.ready);
      const before = await button.boundingBox();
      if (mode !== "autofill") await button.click();
      await expect(page.locator("html")).toHaveAttribute("data-passkey-sheet", mode === "enroll" ? "create" : "get");
      await expect(page.getByRole("status").filter({ hasText: t("auth.login.pending") })).toHaveCount(0);
      if (mode === "autofill") {
        await idField.focus();
        await expect(button).toBeEnabled();
        await expect(container).not.toHaveAttribute("aria-busy", "true");
      } else {
        await expect(container).toHaveAttribute("aria-busy", "true");
        for (const control of await region.locator("button").all()) await expect(control).toBeDisabled();
        for (const input of await region.locator("input").all()) await expect(input).not.toBeEditable();
      }
      await page.evaluate(() => window.dispatchEvent(new Event("test-passkey-select")));
      await expect.poll(fixture.attempts).toBe(1);
      await expect(container).toHaveAttribute("aria-busy", "true");
      for (const control of await region.locator("button").all()) await expect(control).toBeDisabled();
      for (const input of await region.locator("input").all()) await expect(input).not.toBeEditable();
      if (mode === "autofill") await expect(idField).toBeFocused();
      await expect(page.getByRole("status").filter({ hasText: t("auth.login.pending") })).toHaveCount(0);
      expect(await button.boundingBox()).toEqual(before);
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBe(0);
        await info.attach(`${mode}-${width}-${theme}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      }
      await expectAxe(page, `${mode}/pending/${width}`);
      expect(fixture.unexpected).toEqual([]);
      fixture.release();
      await expect(button).toBeEnabled();
      await expect(container).not.toHaveAttribute("aria-busy", "true");
      if (mode === "autofill") await expect(idField).toBeFocused();
    } finally { await page.close(); fixture.release(); }
  });
}


test("manual sign-in stays busy when it aborts passive autofill", async ({ page }) => {
  const fixture = await accountSecurityPasskey(page, "autofill");
  try {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("data-passkey-sheet", "get");
    const button = page.getByRole("button", { name: t("auth.login.passkey"), exact: true });
    await button.click();
    await expect(page.locator(".auth__card")).toHaveAttribute("aria-busy", "true");
    await expect(button).toBeDisabled();
    await expect(page.locator("html")).toHaveAttribute("data-passkey-sheet", "get");
    await page.evaluate(() => window.dispatchEvent(new Event("test-passkey-select")));
    await expect.poll(fixture.attempts).toBe(1);
    await expect(button).toBeDisabled();
    fixture.release();
    await expect(button).toBeEnabled();
  } finally { await page.close(); fixture.release(); }
});

test("explicit sign-in completes while autofill is pending and discards a late selection", async ({ page }) => {
  const fixture = await accountSecurityPasskey(page, "autofill", { lateAnswer: true });
  const finish = "/api/v1/auth/passkey/login/finish";
  await mockRoute(page, "post", finish, { status: 200, json: token() });
  try {
    await page.goto("/login");
    const sheet = page.locator("html");
    await expect(sheet).toHaveAttribute("data-passkey-sheet", "get");
    await page.getByRole("button", { name: t("auth.login.passkey"), exact: true }).click();
    await expect(sheet).toHaveAttribute("data-passkey-sheet", "get");
    await page.evaluate(() => window.dispatchEvent(new Event("test-passkey-select")));
    await expect(page.getByRole("button", { name: t("shell.logout"), exact: true })).toBeVisible();

    const lateSubmissions = await page.evaluate(async path => {
      let submissions = 0;
      const send = window.fetch;
      window.fetch = (...args) => {
        const input = args[0];
        if (new URL(input instanceof Request ? input.url : input, location.href).pathname === path) submissions++;
        return send(...args);
      };
      try {
        window.dispatchEvent(new Event("test-passkey-late-select"));
        await new Promise(requestAnimationFrame);
        return submissions;
      } finally { window.fetch = send; }
    }, finish);
    expect(lateSubmissions).toBe(0);
  } finally { await page.close(); fixture.release(); }
});
