// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { experienceState } from "../experience";
import { screens } from "../states/registry";
import { inbox } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

/** Three org-change drafts, the first two folded under one row, opened on `path`. */
async function openDrafts(page: Page, path: string) {
  const fixture = await mockScreen(page, screens[0], "populated");
  const queue = inbox(3);
  queue.items = queue.items.map((item, index) => ({
    ...item, kind: "org_change_draft", title: `검증부서 ${index + 1}`,
    id: `org_change:${index}`, fold_key: index < 2 ? "org-change-drafts" : undefined,
    links: [{ kind: "org_change", id: String(index) }], context: { reason: index === 0 ? "NEW" : "REORG" },
  }));
  await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: queue });
  await page.goto(path);
  return fixture;
}
const reason = () => t("home.inbox.reason.org_change_draft");
const fold = (page: Page) => page.getByRole("main").getByRole("button", { name: t("home.inbox.foldCount", { kind: t("home.part.changes"), count: 2 }), exact: true });

for (const path of ["/", "/inbox"]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`org-change queue reasons use inbox catalogs on ${path} at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await openDrafts(page, path);
    try {
      // How often a fold repeats the reason, and whether a phone's queue shows it, is each style's own (pinned below);
      // the server's codes never show.
      const main = page.getByRole("main");
      if (width === 1440) await expect(main.getByText(reason(), { exact: true }).first()).toBeVisible();
      await page.screenshot({ path: info.outputPath(`org-change-reasons-collapsed-${width}-${theme}.png`), fullPage: true });
      await expect(main.getByText(/^(NEW|REORG)$/)).toHaveCount(0);
      await fold(page).click();
      await expect(main.getByRole("button", { expanded: true })).toHaveCount(1);
      if (width === 1440) await expect(main.getByText(reason(), { exact: true }).first()).toBeVisible();
      await expect(main.getByText(/^(NEW|REORG)$/)).toHaveCount(0);
      await fits(page, `org-change reasons/${path}/${width}/${theme}`);
      await expectAxe(page, `org-change reasons/${path}/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`org-change-reasons-${width}-${theme}.png`), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

// Classic writes the reason on the fold row and on each leaf it opens, at a phone's width too; no board draws the
// queue's folds, so the Console counts are the render's (desk only: a phone's queue has no board).
for (const path of ["/", "/inbox"]) for (const width of [1440, 390]) test(`Classic repeats an org-change reason per fold row and leaf on ${path} at ${width}px`, { tag: "@baseline" }, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openDrafts(page, path);
  const region = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
  await expect(region.getByText(reason(), { exact: true })).toHaveCount(2);
  await fold(page).click();
  await expect(region.getByText(reason(), { exact: true })).toHaveCount(4);
});

test.describe("console look", () => {
  test.use({ storageState: experienceState("console") });
  for (const path of ["/", "/inbox"]) test(`Console writes an org-change reason per row on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDrafts(page, path);
    const grid = page.getByRole("grid", { name: t("home.inbox.title"), exact: true });
    await expect(grid.getByText(reason(), { exact: true })).toHaveCount(2);
    await fold(page).click();
    await expect(grid.getByText(reason(), { exact: true })).toHaveCount(3);
  });
});
