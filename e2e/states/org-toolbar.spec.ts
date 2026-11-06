// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id, screenAccess, structure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

async function openChart(page: Page, width: number) {
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
  return { fixture, tree };
}

for (const width of [1440, 390]) {
  test(`org: a workplace centre click after find selects it at ${width}px @ui-state`, async ({ page }) => {
    const { fixture, tree } = await openChart(page, width);
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
        await page.screenshot({ path: test.info().outputPath(`find-${theme}.png`) });
        // A lazy canvas stylesheet can arrive after the chart’s decoration rules.
        await page.evaluate(() => {
          const layer = document.querySelector('[class*="layer"]')!;
          const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
          const rule = rules.find(rule => rule instanceof CSSStyleRule && rule.selectorText.includes("layer") && rule.selectorText.endsWith("> *"));
          if (!rule) throw new Error("Canvas interaction rule missing");
          const late = document.createElement("style");
          late.textContent = rule.cssText;
          document.head.append(late);
          const decorations = layer.querySelectorAll(':scope > svg, :scope > [role="tooltip"]');
          if (!decorations.length) throw new Error("Chart preview missing");
          for (const decoration of decorations) {
            if (getComputedStyle(decoration).pointerEvents !== "none") throw new Error("Chart decoration intercepts the pointer");
          }
        });
        await page.mouse.click(centre.x, centre.y);
        await expect(workplace).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.locator('[data-box][data-s~="edit"]')).toHaveCount(0);
        await fits(page, `org find/${width}/${theme}`);
        await page.keyboard.press("Escape");
      }
      await expectAxe(page, `org toolbar/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const width of [1440, 390]) {
  test(`org: workplace tools leave the parent corner clear at ${width}px @ui-state`, async ({ page }) => {
    const { fixture, tree } = await openChart(page, width);
    try {
      await page.goto("/org");
      const find = page.getByRole("searchbox", { name: t("structure.find.label"), exact: true });
      const workplace = page.locator(`[data-box][data-id="${id(303)}"]`);
      const parent = page.locator(`[data-box][data-id="${id(203)}"]`);
      const toolbar = page.getByRole("toolbar", { name: t("structure.tools.label", { name: tree.entities[3]!.children[0]!.name }), exact: true });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await find.fill(tree.entities[3]!.children[0]!.name);
        await find.press("Enter");
        await expect(workplace).toHaveAttribute("data-s", /now/);
        await workplace.click();
        await expect(workplace).toHaveAttribute("aria-selected", "true");
        await expect(toolbar).toBeVisible();
        const corner = await parent.evaluate(el => {
          const r = el.getBoundingClientRect();
          return { x: r.right - 8, y: r.bottom - 8 };
        });
        await page.mouse.click(corner.x, corner.y);
        await expect(parent).toHaveAttribute("aria-selected", "true");
        await expect(page.locator('[data-box][data-s~="edit"]')).toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);

        // Pan the found box flush with the area below the floating controls.
        await workplace.click();
        const edge = await find.evaluate(el => el.closest('[class*="top"]')!.getBoundingClientRect().bottom + 8);
        const bounds = (await workplace.boundingBox())!;
        await workplace.dispatchEvent("wheel", { deltaY: bounds.y - edge });
        await expect.poll(async () => Math.abs((await workplace.boundingBox())!.y - edge)).toBeLessThan(1);
        await expect(toolbar.getByRole("button").first()).toBeInViewport();
        await expect.poll(() => toolbar.evaluate(el => {
          const r = el.getBoundingClientRect();
          return [...document.querySelectorAll('[data-box]')].every(box => {
            const b = box.getBoundingClientRect();
            return r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom;
          });
        })).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`top-${theme}.png`) });
        await fits(page, `org toolbar edge/${width}/${theme}`);
        const topCorner = await parent.evaluate(el => {
          const r = el.getBoundingClientRect();
          return { x: r.right - 2, y: r.bottom - 2 };
        });
        await page.mouse.click(topCorner.x, topCorner.y);
        await expect(parent).toHaveAttribute("aria-selected", "true");
        await expect(page.locator('[data-box][data-s~="edit"]')).toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await find.fill(tree.entities[3]!.name);
        await find.press("Enter");
        await fits(page, `org toolbar/${width}/${theme}`);
        await page.screenshot({ path: test.info().outputPath(`parent-${theme}.png`) });
        await page.keyboard.press("Escape");
      }
      await expectAxe(page, `org toolbar/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
