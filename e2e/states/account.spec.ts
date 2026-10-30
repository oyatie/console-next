// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { ApiError } from "@console/api";
import { failureText } from "../../apps/web/src/lib/refusal";
import { expectAxe, fits } from "../a11y";
import { accountReads, accountReference } from "../mock/account";
import { user } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { accountScreens, type AccountState } from "./account";

test.beforeAll(() => loadCatalog("ko"));
for (const screen of accountScreens) for (const state of Object.keys(screen.states) as AccountState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await accountReads(page, state) };
    await page.goto(screen.path);
    await page.getByRole("button", { name: t("account.name.edit"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: t("account.name.edit") });
    await expect(dialog).toBeVisible();
    const name = state === "save-unchanged" ? `  ${user.display_name}  ` : "박담당";
    await dialog.getByRole("textbox").fill(name);
    const submit = dialog.getByRole("button", { name: t("account.name.edit"), exact: true });
    await submit.click();
    if (state === "save-unchanged") {
      await expect(dialog).toHaveCount(0);
      expect(fixture.writes).toEqual([]);
      await page.getByRole("button", { name: t("account.name.edit"), exact: true }).click();
      await expect(dialog.getByRole("textbox")).toHaveValue(user.display_name);
    } else {
      const refused = state === "save-403";
      const banner = dialog.getByRole(refused ? "alert" : "status");
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute("data-tone", refused ? "danger" : "info");
      if (refused) {
        await expect(banner).toContainText(failureText(new ApiError(403, "forbidden", "요청을 처리하지 못했습니다.")));
        await expect(submit).toBeEnabled();
      } else {
        await expect(banner).toContainText(t("requestOutcome.checking"));
        await expect(banner).toContainText(t("requestOutcome.remedy"));
        await expect(banner.getByRole("button", { name: t("requestOutcome.check"), exact: true })).toBeEnabled();
        await expect(submit).toBeDisabled();
      }
      if (state === "save-500") await expect(banner.getByText(accountReference.slice(0, 8), { exact: true })).toBeVisible();
      await expect(dialog.getByRole("textbox")).toHaveValue(name);
      expect(fixture.writes).toEqual([{ display_name: name }]);
    }
    await expect(page.getByText(t("account.name.saved"), { exact: true })).toHaveCount(0);
    await fits(page, `${screen.key}/${state}/${width}`);
    await expectAxe(page, `${screen.key}/${state}/${width}`);
    expect(errors).toEqual([]);
    expect(fixture.unexpected, "register every supporting read").toEqual([]);
  });
}
