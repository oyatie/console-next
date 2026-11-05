// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { inbox } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/", "/inbox"]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`org-change queue reasons use inbox catalogs on ${path} at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[0], "populated");
    const queue = inbox(3);
    queue.items = queue.items.map((item, index) => ({
      ...item, kind: "org_change_draft", title: `검증부서 ${index + 1}`,
      id: `org_change:${index}`, fold_key: index < 2 ? "org-change-drafts" : undefined,
      links: [{ kind: "org_change", id: String(index) }], context: { reason: index === 0 ? "NEW" : "REORG" },
    }));
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: queue });
    try {
      await page.goto(path);
      const region = page.getByRole("region", { name: t("home.inbox.title"), exact: true });
      const reason = t("home.inbox.reason.org_change_draft");
      await expect(region.getByText(reason, { exact: true })).toHaveCount(2);
      await page.screenshot({ path: info.outputPath(`org-change-reasons-collapsed-${width}-${theme}.png`), fullPage: true });
      await expect(region.getByText(/^(NEW|REORG)$/)).toHaveCount(0);
      const fold = region.getByRole("button", { name: t("home.inbox.foldCount", { kind: t("home.part.changes"), count: 2 }), exact: true });
      await fold.click();
      await expect(fold).toHaveAttribute("aria-expanded", "true");
      await expect(region.getByText(reason, { exact: true })).toHaveCount(4);
      await expect(region.getByText(/^(NEW|REORG)$/)).toHaveCount(0);
      await fits(page, `org-change reasons/${path}/${width}/${theme}`);
      await expectAxe(page, `org-change reasons/${path}/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`org-change-reasons-${width}-${theme}.png`), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
