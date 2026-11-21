// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expectFitsViewport, expectPatternMatrixClean, openPatternFixture, setConsoleViewport } from "./pattern-browser-helpers";
import type { MountedGallery } from "../../lib/gallery-browser-test";

let mounted: MountedGallery;

beforeAll(async () => {
  mounted = await openPatternFixture("canvas");
}, 60_000);

afterAll(async () => {
  await mounted?.close();
});

test("Canvas pattern passes WCAG 2.2 AA matrix, fits 390px and 320px, zooms OrgCanvas, and supports keyboard tree navigation + Escape focus restore", async () => {
  const { page } = mounted;
  await expectPatternMatrixClean(page);
  await expectFitsViewport(page, 320);

  await setConsoleViewport(page, 1440, 900);
  const zoomLive = page.locator('[role="group"][aria-label="' + t("uiOrgCanvas.zoom") + '"] [aria-live="polite"]');
  const initialZoom = await zoomLive.textContent();
  await page.getByRole("button", { name: t("uiOrgCanvas.zoomIn"), exact: true }).click();
  expect(await zoomLive.textContent()).not.toBe(initialZoom);
  await page.getByRole("button", { name: t("uiOrgCanvas.fit"), exact: true }).click();
  expect(await zoomLive.textContent()).toBe(initialZoom);

  const rootNode = page.locator("#node-root");
  await rootNode.focus();
  await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("node-entity");
  await page.keyboard.press("Enter");
  await page.locator('[data-pane="record"]').waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-pane="record"]'));
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("node-entity");

  // Deterministic regression: pressing End before the post-Escape rAF fires must keep focus on #node-dept.
  await page.locator("#node-entity").focus();
  await page.keyboard.press("Enter");
  await page.locator('[data-pane="record"]').waitFor();
  const activeAfterImmediateEnd = await page.evaluate(
    () =>
      new Promise<string | null>(resolve => {
        const entity = document.getElementById("node-entity");
        const obs = new MutationObserver(() => {
          if (!document.querySelector('[data-pane="record"]')) {
            obs.disconnect();
            entity?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.activeElement?.id ?? null)));
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        entity?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      }),
  );
  expect(activeAfterImmediateEnd).toBe("node-dept");

  // Regression: toggling depth ("Sites only") while focused on #node-dept preserves a roving tabIndex="0" stop.
  await page.locator("#node-entity").focus();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 5000 }).toBe("node-entity");
  await page.keyboard.press("End");
  await expect.poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 5000 }).toBe("node-dept");
  await page.getByRole("button", { name: tg("pat.canvas.depthSites"), exact: true }).click();
  expect(await page.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
  expect(await page.locator('#node-root[tabindex="0"]').count()).toBe(1);

  // Regression: fresh 390x844 load and 1440 -> 390 resize keep all visible nodes inside .viewport without overlapping .zoom
  // and keep .canvasFoot inside the real 390x844 viewport without vertical overflow.
  await page.getByRole("button", { name: tg("pat.canvas.depthAll"), exact: true }).click();
  await setConsoleViewport(page, 390, 844);
  const check390Geometry = async () => {
    await expect.poll(async () => {
      const geom = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>("main");
        const vp = document.querySelector('[data-pattern="canvas"] section > div')!.getBoundingClientRect();
        const zoom = document.querySelector('[data-pattern="canvas"] [role="group"]')!.getBoundingClientRect();
        const foot = document.querySelector<HTMLElement>('[class*="canvasFoot"]')?.getBoundingClientRect();
        const nodes = [...document.querySelectorAll<HTMLElement>('[id^="node-"]')].map(el => {
          const r = el.getBoundingClientRect();
          return {
            id: el.id,
            insideVp: r.left >= vp.left - 0.5 && r.right <= vp.right + 0.5 && r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5,
            overlapsZoom: r.left < zoom.right && r.right > zoom.left && r.top < zoom.bottom && r.bottom > zoom.top,
            overlapsFoot: foot ? r.left < foot.right && r.right > foot.left && r.top < foot.bottom && r.bottom > foot.top : false,
            topOffset: Math.round(r.top - vp.top),
          };
        });
        const mainRect = main?.getBoundingClientRect();
        return {
          count: nodes.length,
          allInside: nodes.every(n => n.insideVp),
          noneOverlapsZoom: nodes.every(n => !n.overlapsZoom),
          noneOverlapsFoot: nodes.every(n => !n.overlapsFoot),
          firstTopOffset: nodes[0]?.topOffset ?? 999,
          mainFits: main ? main.scrollHeight <= main.clientHeight + 0.5 : true,
          footVisible: Boolean(foot && mainRect && foot.bottom <= mainRect.bottom + 0.5 && foot.bottom <= window.innerHeight + 0.5),
        };
      });
      return (
        geom.count === 4 &&
        geom.allInside &&
        geom.noneOverlapsZoom &&
        geom.noneOverlapsFoot &&
        geom.firstTopOffset < 60 &&
        geom.mainFits &&
        geom.footVisible
      );
    }, { timeout: 5000 }).toBe(true);
  };
  await check390Geometry();
  await page.reload();
  await page.locator('[data-pattern="canvas"]').waitFor();
  await setConsoleViewport(page, 390, 844);
  await check390Geometry();
}, 45_000);
