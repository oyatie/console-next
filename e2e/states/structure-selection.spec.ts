// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { screenAccess, structure } from "../mock/fixtures";
import { orgPanelReads } from "../mock/org-work";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { box, findBox, revealUnit } from "../structure-flows";
import { screens } from "./registry";
import { expectAxe, fits } from "../a11y";

test.beforeAll(() => loadCatalog("ko"));

for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
  test(`org: select a setup workplace beside its hover action at ${viewport.width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await mockScreen(page, screens[2], "populated");
    await orgPanelReads(page);
    const tree = structure(1);
    tree.phase = "SETUP";
    const workplace = tree.entities[0]!.children[0]!;
    workplace.name = t("structure.node.headOffice");
    workplace.children = [];
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/org", "SETUP"), is_ops: true } });
    try {
      await page.goto("/org");
      await expect(box(page, workplace.name).getByText(workplace.name, { exact: true })).toHaveCount(2);
      await revealUnit(page, workplace.name);
      await expect(box(page, workplace.name)).toHaveAttribute("aria-selected", "true");
      await expect(box(page, workplace.name)).toBeFocused();
      const tools = page.getByRole("toolbar", { name: t("structure.tools.label", { name: workplace.name }), exact: true });
      await tools.getByRole("button", { name: t("structure.tools.addDept"), exact: true }).click();
      await expect(page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: workplace.name }), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const width of [1440, 390]) test(`org: multi-selection actions remain accessible at ${width}px in both themes @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const tree = structure(3);
  tree.phase = "SETUP";
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", "SETUP") });
  try {
    await page.goto("/org");
    await page.getByRole("button", { name: t("structure.depth.all"), exact: true }).click();
    for (const name of ["검증부서 1", "검증부서 2"]) {
      await findBox(page, name);
      await box(page, name).click({ modifiers: ["Shift"] });
    }
    await expect(page.getByRole("region", { name: t("structure.selection.label"), exact: true })).toBeVisible();
    await expect(box(page, "검증부서 2").getByRole("button", { name: t("structure.menu.label", { name: "검증부서 2" }), exact: true })).toBeVisible();
    await expectAxe(page, `org/multi-selection/${width}`);
    await fits(page, `org/multi-selection/${width}`);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
