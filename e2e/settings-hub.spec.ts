// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { openTenant } from "./helpers/tenant";
import { go } from "./flows";
import { expectAxe, fits } from "./a11y";

test.beforeAll(() => loadCatalog("ko"));

test("a first-run tenant operator reaches the served settings pages from one hub", async ({ browser }) => {
  const page = await openTenant(browser, "settingshub", "설정 검증 회사");
  const rows = [
    ["/settings/company-domain", "shell.settings.domain", "account.domain.title"],
    ["/people/numbering", "identifiers.numbering.title", "identifiers.numbering.title"],
    ["/people/job-titles", "shell.settings.titles", "titles.title"],
    ["/people/period-locks", "periodLocks.title", "periodLocks.title"],
  ] as const;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const identity = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/users/me" && response.ok());
    await go(page, "/settings");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: t("shell.link.settings"), exact: true })).toBeVisible();
    await expect(main.getByRole("link")).toHaveCount(4);
    const { sign_in_id } = await (await identity).json();
    await expect(main.getByRole("region", { name: t("shell.settings.domain"), exact: true })).toContainText(sign_in_id.split("@")[1]);
    await expect(main.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText(t("settingsHub.numbering.empty"));
    const approval = main.getByRole("region", { name: t("settingsHub.approval"), exact: true });
    await expect(approval).toContainText(t("settingsHub.approval.direct"));
    await expect(approval.getByRole("link")).toHaveCount(0);
    await expect(approval.getByRole("list")).toHaveCount(0);
    await fits(page, `live settings/${width}`);
    await expectAxe(page, `live settings/${width}`);
    for (const [path, label, title] of rows) {
      await go(page, "/settings");
      await main.getByRole("link", { name: t(label), exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(main.getByRole("heading", { level: 1, name: t(title), exact: true }).first()).toBeVisible();
    }
  }
  await page.close();
});
