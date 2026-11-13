// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { expectAxe, fits } from "../a11y";
import { authz, failure, id } from "../mock/fixtures";
import { orgChange } from "../mock/org-changes";
import { orgWorkReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { entityRecordPath, mockEntityRecord } from "./entity-record";
import { orgChangeScreens, screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

async function inspect(page: Page, label: string) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await fits(page, `${label}/${theme}`);
    await expectAxe(page, `${label}/${theme}`);
    await page.screenshot({ path: test.info().outputPath(`${theme}.png`), fullPage: true });
  }
}

for (const width of [1440, 390]) {
  test(`entity: a revision denial preserves the input and locks the sheet at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockEntityRecord(page, "populated");
    let writes = 0;
    await mockRoute(page, "put", "/api/v1/legal-entities/{entityId}", () => {
      writes++;
      return { status: 403, json: failure("forbidden") };
    });
    try {
      await page.goto(entityRecordPath);
      const field = t("entityCreate.field.displayName");
      await page.getByRole("button", { name: t("uiRecordActions.of", { field, verb: t("uiRecordActions.edit") }), exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("radio", { name: t("entityRecord.revise.verb.cor"), exact: false }).press("Space");
      const input = dialog.getByRole("textbox", { name: field, exact: false, includeHidden: true });
      await input.fill("검증 상호");
      const confirm = dialog.getByRole("button", { name: commitLabel({ kind: "entityCorrection", mode: "record" }), exact: true });
      await confirm.click();
      await expect(dialog.getByRole("alert")).toHaveCount(1);
      await inspect(page, `entity revision/${width}`);
      await expect(confirm).toBeDisabled();
      await expect(input).toHaveValue("검증 상호");
      expect(await input.evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
      await confirm.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
      expect(writes).toBe(1);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  test(`org: submit denial locks the commit and secondary writes at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, orgChangeScreens[1], "draft");
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities,
      { feature: "org_change_draft", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false },
    ] } });
    const record = { ...orgChange("draft"), effectiveDate: "2099-11-01" };
    await mockRoute(page, "get", "/api/v1/org-changes/{id}", { status: 200, json: record });
    let writes = 0;
    await mockRoute(page, "post", "/api/v1/org-changes/{id}/submit", () => {
      writes++;
      return { status: 403, json: failure("org_change.refuse.missing_grant") };
    });
    try {
      await page.goto(orgChangeScreens[1].path);
      const panel = page.getByRole("region", { name: t("orgChange.next.title"), exact: true });
      const confirm = panel.getByRole("button", { name: commitLabel({ kind: "orgChange", mode: "schedule" }), exact: true });
      await confirm.click();
      await expect(panel.getByRole("alert")).toContainText(t("org_change.refuse.missing_grant"));
      await inspect(page, `submit refusal/${width}`);
      await expect(confirm).toBeDisabled();
      for (const key of ["orgChange.edit", "orgChange.cancel"] as const) {
        const secondary = panel.getByRole("button", { name: t(key), exact: true, includeHidden: true });
        expect(await secondary.evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
        expect(await secondary.evaluate(el => getComputedStyle(el.closest("[inert]")!).opacity)).toBe("0.5");
      }
      await confirm.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
      expect(writes).toBe(1);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  for (const phase of ["populated", "operating"] as const) {
    test(`org: bulk move denial locks ${phase} inputs and draft at ${width}px @ui-state`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await mockScreen(page, screens[2], "populated");
      await orgWorkReads(page, phase);
      let writes = 0;
      const refuse = () => { writes++; return { status: 403 as const, json: failure("org_change.refuse.missing_grant") }; };
      await mockRoute(page, "post", "/api/v1/org-structure/batches", refuse);
      await mockRoute(page, "post", "/api/v1/org-changes", refuse);
      try {
        await page.goto(`/org/move?ids=${id(100)}`);
        const main = page.getByRole("main");
        const tree = main.getByRole("treegrid", { name: t("bulkMove.where"), exact: true, includeHidden: true });
        await tree.getByRole("row", { name: /^검증부서 2/ }).click();
        if (phase === "operating") {
          await main.getByRole("button", { name: /^오늘/ }).click();
          await main.getByRole("textbox", { name: /^사유/ }).fill("부서 이동 검토");
        }
        const confirm = main.getByRole("button", { name: commitLabel({ kind: "orgMove", mode: "apply", count: 1 }), exact: true });
        await confirm.click();
        await expect(main.getByRole("alert")).toContainText(t("org_change.refuse.missing_grant"));
        await inspect(page, `move refusal/${phase}/${width}`);
        await expect(confirm).toBeDisabled();
        expect(await tree.evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
        if (phase === "operating") {
          await expect(main.getByRole("textbox", { name: /^사유/, includeHidden: true })).toHaveValue("부서 이동 검토");
          await expect(main.getByRole("button", { name: t("composer.saveDraft"), exact: true })).toBeDisabled();
        }
        await confirm.dispatchEvent("keydown", { key: "Enter", ctrlKey: true });
        expect(writes).toBe(1);
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }
}
