// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { expectAxe, fits } from "../a11y";
import { authz, id } from "../mock/fixtures";
import { orgChange } from "../mock/org-changes";
import { orgPanelReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { orgChangeScreens, screens } from "./registry";

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
      const confirm = dialog.getByRole("button", { name: commitLabel({ kind: "orgChange", mode: refusal.cancel ? "cancel" : "change" }), exact: true });
      if (refusal.status === 403) {
        await expect(confirm).toBeDisabled();
        await page.keyboard.press("ControlOrMeta+Enter");
      } else await expect(confirm).toBeEnabled();
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

for (const width of [1440, 390]) {
  test(`org: a decision refusal locks confirm at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = orgChangeScreens[1];
    const fixture = await mockScreen(page, screen, "approval");
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities,
      { feature: "org_change_approve", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false },
    ] } });
    const record = { ...orgChange("approval"), draftedBy: id(5) };
    await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: record });
    let writes = 0;
    await mockRoute(page, "post", "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", () => {
      writes++;
      return { status: 403, json: { error: { code: "org_change.refuse.missing_grant", message: "Server refusal" } } };
    });
    try {
      await page.goto(screen.path);
      const panel = page.getByRole("region", { name: t("orgChange.next.title"), exact: true });
      await panel.locator("summary").click();
      const comment = panel.getByRole("textbox");
      await comment.fill("검토 의견 보존");
      const confirm = panel.getByRole("button", { name: commitLabel({ kind: "orgChange", mode: "approve" }), exact: true });
      await confirm.click();
      await expect(panel.getByRole("alert")).toContainText(t("org_change.refuse.missing_grant"));
      await page.screenshot({ path: test.info().outputPath("refusal.png") });
      await expect(confirm).toBeDisabled();
      await expect(comment).toHaveValue("검토 의견 보존");
      await panel.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await confirm.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
      expect(writes).toBe(1);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `decision refusal/${width}/${theme}`);
        await expectAxe(page, `decision refusal/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`decision-${theme}.png`) });
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}


for (const width of [1440, 390]) {
  test(`org: a department refusal locks confirm and draft at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens.find(screen => screen.key === "org")!, "populated");
    const panel = await orgPanelReads(page);
    let writes = 0;
    await mockRoute(page, "post", "/api/v1/org-changes", () => {
      writes++;
      return { status: 403, json: { error: { code: "org_change.refuse.missing_grant", message: "Server refusal" } } };
    });
    try {
      await page.goto(`/org?sel=${id(4)}&act=dept-add`);
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: new RegExp(`^${t("orgUnit.gov.name")}`) }).fill("검증부서 신설");
      const reason = dialog.getByRole("textbox", { name: new RegExp(`^${t("orgUnit.gov.reason")}`) });
      await reason.fill("조직 운영 개선");
      const confirm = dialog.getByRole("button", { name: commitLabel({ kind: "orgCreate", mode: "apply", count: 1 }), exact: true });
      await confirm.click();
      await expect(dialog.getByRole("alert")).toContainText(t("org_change.refuse.missing_grant"));
      await page.screenshot({ path: test.info().outputPath("refusal.png") });
      await expect(confirm).toBeDisabled();
      await expect(dialog.getByRole("button", { name: t("composer.saveDraft"), exact: true })).toBeDisabled();
      await expect(reason).toHaveValue("조직 운영 개선");
      await dialog.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await confirm.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
      expect(writes).toBe(1);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `department refusal/${width}/${theme}`);
        await expectAxe(page, `department refusal/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`department-${theme}.png`) });
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); panel.release(); fixture.release(); }
  });
}
