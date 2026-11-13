// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { box } from "../structure-flows";
import { orgPanelReads, orgWorkReads } from "./org-work";
import { authz } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

async function openChart(page: Page) {
  const fixture = await mockScreen(page, screens[2], "populated");
  await orgPanelReads(page);
  const { tree } = await orgWorkReads(page, "operating");
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: { ...authz,
    capabilities: [...authz.capabilities, { feature: "org_change_draft", permission: "allow", branch_scope: { kind: "all" }, org_wide: true, scoped: false }],
  } });
  return { fixture, tree };
}

test("an opened chart menu takes the toolbar from the selection", async ({ page }) => {
  const { fixture, tree } = await openChart(page);
  const entity = tree.entities[0]!;
  const parent = entity.children[0]!;
  try {
    await page.goto("/org");
    await box(page, parent.name).click();
    await box(page, entity.name).focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(box(page, parent.name)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("toolbar")).toHaveCount(1);
    await expect(page.getByRole("toolbar", { name: t("structure.tools.label", { name: entity.name }), exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});

for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
  test(`inline department editor keeps one chart toolbar at ${width}px in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const { fixture, tree } = await openChart(page);
    const parent = tree.entities[0]!.children[0]!;
    parent.children = parent.children.slice(0, 1);
    tree.entities[0]!.chips = ["unverified"];
    for (const node of [tree.entities[0]!, parent, ...parent.children]) {
      node.headcount = 0;
      node.direct_headcount = 0;
    }
    try {
      await page.goto("/org");
      await box(page, parent.name).click();
      await page.keyboard.press("a");
      const field = page.getByRole("textbox", { name: t("structure.edit.addLabel", { parent: parent.name }), exact: true });
      await expect(field).toBeFocused();
      // A pan can leave the pointer over another box while keyboard focus stays in the editor.
      await box(page, tree.entities[0]!.name).dispatchEvent("pointerover");
      await expect(page.getByRole("toolbar")).toHaveCount(1);
      await expect(page.getByRole("toolbar", { name: t("structure.tools.label", { name: parent.name }), exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expectAxe(page, "inline department editor");
      await fits(page, `inline department editor ${width} ${theme}`);
      await page.screenshot({ path: info.outputPath("inline-editor.png") });
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const selection of ["none", "root", "collapsed"] as const) {
  test(`chart hover actions remain available with ${selection} selection`, async ({ page }) => {
    const { fixture, tree } = await openChart(page);
    const entity = tree.entities[0]!;
    const parent = entity.children[0]!;
    try {
      await page.goto("/org");
      if (selection === "root") {
        const root = page.getByRole("tree", { name: /조직도$/ }).getByRole("treeitem", { name: /^전체/ });
        await root.click();
        await expect(root).toHaveAttribute("aria-selected", "true");
      } else if (selection === "collapsed") {
        await page.getByRole("button", { name: t("structure.node.expand", { name: parent.name, count: parent.children.length }), exact: true }).click();
        const dept = box(page, parent.children[0]!.name);
        await dept.click();
        await expect(dept).toHaveAttribute("aria-selected", "true");
        await page.getByRole("button", { name: t("structure.node.collapseLabel", { name: parent.name }), exact: true }).click();
        await expect(dept).toHaveCount(0);
      }
      // The clicks leave the real pointer on a box, and the browser re-sends pointerover to it when the layout shifts.
      await page.mouse.move(0, 0);
      for (const node of [parent, entity]) {
        await box(page, node.name).dispatchEvent("pointerover");
        await expect(page.getByRole("toolbar")).toHaveCount(1);
        await expect(page.getByRole("toolbar", { name: t("structure.tools.label", { name: node.name }), exact: true })).toBeVisible();
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
