// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { AT } from "../mock/fixtures";
import { numberingReads } from "../mock/numbering";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { numberingScreens, type NumberingState } from "./numbering";

test.beforeAll(() => loadCatalog("ko"));
const screen = numberingScreens[0];
for (const state of Object.keys(screen.states) as NumberingState[]) for (const width of [1440, 390]) {
  test(`numbering: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = { ...await mockScreen(page, screens[0], "populated"), ...await numberingReads(page, state) };
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main").locator(".page").filter({ has: page.getByRole("heading", { level: 1, name: t("identifiers.numbering.title"), exact: true }) });
      await expect(main.getByRole("heading", { level: 1, name: t("identifiers.numbering.title"), exact: true })).toBeVisible();
      const card = main.getByRole("region", { name: t("identifiers.renumber.title"), exact: true });
      const after = main.getByText(t("identifiers.renumber.whyAfter"), { exact: true });
      const preview = card.getByRole("button", { name: t("identifiers.renumber.preview"), exact: true });
      if (state === "phase-loading" || state === "phase-500") {
        if (state === "phase-loading") {
          await expect(main.locator('[data-read-layout="form"][aria-busy="true"]')).toBeVisible();
        } else {
          await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible();
          await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible();
        }
        await expect(card).toHaveCount(0);
        await expect(after).toHaveCount(0);
        await expect(main.locator("input,select,textarea")).toHaveCount(0);
      } else if (state === "operating") {
        await expect(after).toBeVisible();
        await expect(card.locator("p")).toHaveText([t("identifiers.renumber.whyAfter")]);
        await expect(card.locator("input,select,textarea,button")).toHaveCount(0);
      } else {
        await expect(preview).toBeVisible();
        await expect(after).toHaveCount(0);
        await expect(card.getByRole("combobox")).toHaveCount(2);
        await expect(card.getByRole("textbox")).toHaveCount(2);
        await expect(card.getByRole("radiogroup", { name: t("identifiers.renumber.reason") })).toBeVisible();
      }
      await fits(page, `numbering/${state}/${width}`);
      await expectAxe(page, `numbering/${state}/${width}`);
      await page.screenshot({ path: test.info().outputPath(`numbering-${state}-${width}.png`), fullPage: true });
      expect(fixture.writes).toEqual([]);
      if (state === "phase-loading" || state === "phase-500") {
        const before = fixture.phaseReads();
        if (state === "phase-loading") fixture.releasePhase();
        else {
          fixture.recover();
          await main.getByRole("button", { name: t("common.retry"), exact: true }).click();
          await expect.poll(fixture.phaseReads).toBeGreaterThan(before);
        }
        await expect(after).toBeVisible();
        await expect(card.locator("input,select,textarea,button")).toHaveCount(0);
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(0);
      } else if (state === "setup") {
        await card.getByRole("combobox", { name: t("identifiers.renumber.scope") }).selectOption("TENANT");
        await card.getByRole("textbox", { name: t("identifiers.renumber.prefix") }).fill("HG-");
        await card.getByLabel(t("identifiers.renumber.effective")).fill(AT.slice(0, 10));
        await card.getByRole("radiogroup", { name: t("identifiers.renumber.reason") }).getByText(t("reason.employee_number_change.NUMBERING_SCHEME_CHANGE"), { exact: true }).click();
        await preview.click();
        await expect(card.getByRole("grid", { name: t("identifiers.renumber.lines"), exact: true })).toContainText("HG-0001");
        await card.getByRole("button", { name: t("identifiers.renumber.apply", { count: 1 }), exact: true }).click();
        await expect(card).toContainText(t("identifiers.renumber.done", { count: 1 }));
        await card.getByRole("button", { name: t("identifiers.renumber.undo"), exact: true }).click();
        await expect(card).toContainText(t("identifiers.renumber.undone", { count: 1 }));
        expect(fixture.writes.map(url => new URL(url).pathname)).toEqual([
          "/api/v1/employees/renumber/preview", "/api/v1/employees/renumber/apply", expect.stringMatching(/\/api\/v1\/employees\/renumber\/[^/]+\/undo$/),
        ]);
      }
      expect(errors).toEqual([]);
      expect(fixture.unexpected, "register every supporting read").toEqual([]);
    } finally {
      await page.close();
      fixture.releasePhase();
      fixture.release();
    }
  });
}
