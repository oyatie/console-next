// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { fits } from "../a11y";
import { go } from "../flows";
import { AT, id } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const act of ["create", "rename", "move", "dissolve", "reassign"] as const) for (const date of ["2026-11-11", "2026-12-01"]) for (const width of [1440, 390]) {
  test(`${act} proposal dismissal preserves edits but accepts its opening date (${date}, ${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-11-11T12:00:00+09:00"));
    const fixture = await mockScreen(page, screens[2], "populated");
    const { dept } = await orgPanelReads(page);
    await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: ([
      [4, "본사", "SITE", null],
      [100, dept.name, "DEPARTMENT", 4],
      [101, "검증부서 2", "DEPARTMENT", 4],
      [102, "검증부서 3", "DEPARTMENT", 4],
    ] as const).map(([n, name, kind, parent]) => ({
      id: id(n), name, kind, parentId: parent === null ? null : id(parent), status: "ACTIVE" as const,
      effectiveFrom: "2026-01-01", headcount: 1, updatedAt: AT,
    })) } });
    await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: true, items: [] } });
    await mockRoute(page, "get", "/api/v1/period-locks", { status: 200, json: { items: [] } });
    const path = `/org?sel=${act === "create" ? id(4) : dept.id}&act=${act}&as_of=${date}`;
    const proposal = page.getByRole("dialog", { name: t(`orgPropose.title.${act}`, { parent: "본사", kind: "부서", name: dept.name, count: 1 }), exact: true });
    const close = () => proposal.getByRole("button", { name: t("uiSheet.close"), exact: true }).click();
    try {
      await go(page, path);
      const dateField = proposal.getByRole("textbox", { name: /^적용일/ });
      await dateField.focus();
      await expect(dateField).toHaveValue(fmtDate(date));
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await fits(page, `proposal/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`proposal-${theme}.png`) });
      }
      await close();
      await expect(proposal).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("as_of")).toBe(date);
      const fields = act === "create" || act === "rename" ? ["name", "reason", "date"] : ["reason", "date"];
      for (const field of fields) {
        await go(page, path);
        const input = proposal.getByRole("textbox", { name: field === "name" ? (act === "create" ? /^부서 이름/ : /^새 이름/) : field === "reason" ? /^사유/ : /^적용일/ });
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
      if (act === "move" || act === "reassign") {
        await go(page, path);
        const picker = proposal.getByRole("combobox", { name: t(act === "move" ? "orgPropose.field.parent" : "orgPropose.field.to"), exact: true });
        await picker.fill("검증부서 2");
        await expect(page.getByRole("option", { name: /검증부서 2/ })).toBeVisible();
        await picker.press("Escape");
        await close();
        await expect(proposal).toHaveCount(0);

        await go(page, path);
        await picker.fill("검증부서 2");
        await page.getByRole("option", { name: /검증부서 2/ }).click();
        await close();
        await expect(proposal).toBeVisible();
        await expect(proposal.getByRole("status")).toContainText(t("composer.unsaved"));
        await expect(picker).toHaveValue("검증부서 2");
        await close();
        await expect(proposal).toHaveCount(0);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
