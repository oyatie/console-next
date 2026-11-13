// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { authz, screenAccess, structure } from "./fixtures";
import { orgPanelReads } from "./org-work";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));

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
