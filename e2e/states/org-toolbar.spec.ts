// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, screenAccess, structure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) {
  test(`org: a workplace centre click after find selects it at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens.find(screen => screen.key === "org")!, "populated");
    const tree = structure(3);
    tree.phase = "SETUP";
    const entity = tree.entities[0]!;
    tree.entities = Array.from({ length: 4 }, (_, i) => ({
      ...entity, id: id(200 + i), name: `법인 ${i + 1}`,
      children: [{ ...entity.children[0]!, id: id(300 + i), name: `사업장 ${i + 1}`, children: [] }],
    }));
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: screenAccess("/org", "SETUP") });
    await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}", { status: 404, json: failure("not_found") });
    try {
      await page.goto("/org");
      const find = page.getByRole("searchbox", { name: t("structure.find.label"), exact: true });
      const workplace = page.locator(`[data-box][data-id="${id(303)}"]`);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await find.fill(tree.entities[3]!.children[0]!.name);
        await find.press("Enter");
        await expect(workplace).toHaveAttribute("data-s", /now/);
        await expect(workplace).toHaveAttribute("aria-selected", "false");
        await workplace.scrollIntoViewIfNeeded();
        await expect.poll(() => workplace.evaluate(el => {
          const bounds = el.getBoundingClientRect();
          return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest("[data-box]")?.getAttribute("data-id");
        })).toBe(id(303));
        const bounds = (await workplace.boundingBox())!;
        const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        await page.mouse.move(centre.x, centre.y);
        const toolbar = page.getByRole("toolbar", { name: t("structure.tools.label", { name: tree.entities[3]!.children[0]!.name }), exact: true });
        await expect(toolbar).toBeVisible();
        await expect(toolbar.getByRole("button").first()).toBeInViewport();
        await page.mouse.click(centre.x, centre.y);
        await expect(workplace).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.locator('[data-box][data-s~="edit"]')).toHaveCount(0);
        await fits(page, `org find/${width}/${theme}`);
        await expectAxe(page, `org find/${width}/${theme}`);
        await page.keyboard.press("Escape");
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
