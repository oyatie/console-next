// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { fits } from "../a11y";
import { AT, id } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const date of ["2026-11-11", "2026-12-01"]) for (const width of [1440, 390]) {
  test(`proposal dismissal preserves edits but accepts its opening date (${date}, ${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-11-11T12:00:00+09:00"));
    const fixture = await mockScreen(page, screens[2], "populated");
    await orgPanelReads(page);
    await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: [
      { id: id(4), kind: "SITE", name: "본사", parentId: id(1), status: "ACTIVE", effectiveFrom: "2026-01-01", headcount: 3, updatedAt: AT },
    ] } });
    await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: true, items: [] } });
    await mockRoute(page, "get", "/api/v1/period-locks", { status: 200, json: { items: [] } });
    const path = `/org?sel=${id(4)}&act=create&as_of=${date}`;
    const proposal = page.getByRole("dialog", { name: "본사 아래에 부서 신설", exact: true });
    const close = () => proposal.getByRole("button", { name: t("uiSheet.close"), exact: true }).click();
    try {
      await page.goto(path);
      const dateField = proposal.getByRole("textbox", { name: /^적용일/ });
      await expect(dateField).toHaveValue(fmtDate(date));
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `proposal/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`proposal-${theme}.png`) });
      }
      await close();
      await expect(proposal).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("as_of")).toBe(date);
      for (const field of ["name", "reason", "date"] as const) {
        await page.goto(path);
        const input = proposal.getByRole("textbox", { name: field === "name" ? /^부서 이름/ : field === "reason" ? /^사유/ : /^적용일/ });
        await expect(input).toBeVisible();
        const opening = await input.inputValue();
        await input.fill(field === "date" ? "20261202" : "조직 운영 개선");
        await input.press("Tab");
        await close();
        await expect(proposal).toBeVisible();
        await expect(proposal.getByRole("status")).toContainText(t("composer.unsaved"));
        await input.fill(opening);
        await input.press("Tab");
        await input.press("Escape");
        await expect(proposal).toHaveCount(0);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
