// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { t } from "@console/i18n";
import { test } from "../locale-fixture";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { authz, screenAccess, structure } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

for (const width of [1280, 1440, 390]) for (const theme of ["light", "dark"]) {
  test(`list names and actions remain reachable at ${width}px in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[2], "populated");
    await orgPanelReads(page);
    const tree = structure(3);
    tree.phase = "SETUP";
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", "SETUP") });
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz, capabilities: [...authz.capabilities,
      { feature: "org_change_draft", permission: "allow" as const, branch_scope: { kind: "all" as const }, org_wide: true, scoped: false },
    ] } });
    const entity = tree.entities[0]!;
    const site = entity.children[0]!;
    const dept = site.children[0]!;
    await page.goto(`/org?view=list${width > 390 ? `&sel=${dept.id}` : ""}`);
    const grid = page.getByRole("grid", { name: t("structure.list.label"), exact: true });
    await expect(grid).toHaveAttribute("data-layout", "cards");
    for (const [node, role, key] of [
      [entity, "link", "structure.tools.addSite"],
      [site, "button", "structure.tools.addDept"],
      [dept, "button", "structure.tools.addSub"],
    ] as const) {
      const row = grid.locator(`[data-row-id="${node.id}"]`);
      await row.getByRole("rowheader").scrollIntoViewIfNeeded();
      await expect(row.getByText(node.name, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(row.getByRole(role, { name: t(key), exact: true })).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath(`${node.id}.png`) });
    }
    await fits(page, `${width} ${theme}`);
    await expectAxe(page, `${width} ${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const locale of ["ko", "en"] as const) test.describe(`workplace flags in ${locale}`, () => {
  test.use({ locale });
  test("the desktop organization list shows the workplace name and both workplace flags in its row header", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
    const fixture = await mockScreen(page, screens[2], "populated");
    await orgPanelReads(page);
    const tree = structure(1);
    tree.phase = "SETUP";
    const site = tree.entities[0]!.children[0]!;
    site.name = "평택공장";
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    try {
      await page.goto("/org?view=list");
      const grid = page.getByRole("grid", { name: t("structure.list.label"), exact: true });
      await expect(grid).toHaveAttribute("data-layout", "rows");
      const row = grid.locator(`[data-row-id="${site.id}"]`);
      const name = row.getByRole("rowheader");
      for (const label of [site.name, t("structure.node.headOffice"), t("structure.node.primary")]) {
        await expect(name.getByText(label, { exact: true })).toBeInViewport({ ratio: 1 });
      }
      await expect(name.locator("svg.lucide-map-pin")).toBeVisible();
      await expect(row.getByRole("gridcell").getByText(site.name, { exact: true })).toBeInViewport({ ratio: 1 });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
});
