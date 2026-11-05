// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { expectAxe, fits } from "../a11y";
import { authz } from "../mock/fixtures";
import { orgChange } from "../mock/org-changes";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { orgChangeScreens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

const cases = [
  { code: "org_change_scheduled_content", status: 409, cancel: false },
  { code: "org_change_scheduled_locked", status: 403, cancel: false },
  { code: "org_change_scheduled_locked", status: 403, cancel: true },
] as const;

for (const refusal of cases) for (const width of [1440, 390]) {
  test(`org: ${refusal.code} on ${refusal.cancel ? "cancel" : "edit"} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = orgChangeScreens[1];
    const fixture = await mockScreen(page, screen, "scheduled");
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities,
      { feature: "org_change_apply", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false },
    ] } });
    const record = { ...orgChange("scheduled"), effectiveDate: "2026-12-01" };
    await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: record });
    let writes = 0;
    const refuse = () => {
      writes++;
      return { status: refusal.status, json: { error: { code: refusal.code, message: "Untranslated server message" } } };
    };
    if (refusal.cancel) await mockRoute(page, "post", "/api/v1/org-changes/{id}/cancel", refuse);
    else await mockRoute(page, "patch", "/api/v1/org-changes/{id}", refuse);
    try {
      await page.goto(screen.path);
      await page.getByRole("button", { name: t(refusal.cancel ? "orgChange.scheduled.cancel" : "orgChange.scheduled.edit"), exact: true }).click();
      const dialog = page.getByRole("dialog");
      const reason = dialog.getByRole("textbox").last();
      await reason.fill("시행 계획 재검토");
      await dialog.getByRole("button", { name: commitLabel({ kind: "orgChange", mode: refusal.cancel ? "cancel" : "change" }), exact: true }).click();
      const alert = dialog.getByRole("alert");
      await expect(alert).toContainText(t(`common.failed.code.${refusal.code}`));
      await expect(alert).not.toContainText("Untranslated server message");
      await expect(reason).toHaveValue("시행 계획 재검토");
      expect(writes).toBe(1);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `scheduled refusal/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`${theme}.png`) });
      }
      await expectAxe(page, `scheduled refusal/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
