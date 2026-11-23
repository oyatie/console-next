// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { loadCatalog } from "@console/i18n";
import { expect } from "vitest";
import { mountGalleryEntry, scanWcag22Matrix, type MountedGallery } from "../../lib/gallery-browser-test";

export async function openPatternFixture(pattern: string): Promise<MountedGallery> {
  await loadCatalog("ko");
  return mountGalleryEntry({
    name: `${pattern}-pattern`,
    entryPath: `/apps/web/src/ui/patterns/${pattern}.fixture.tsx`,
    readySelector: `[data-pattern="${pattern}"]`,
  });
}

export async function setConsoleViewport(page: Page, width: number, height = 844, theme: "light" | "dark" = "light") {
  await page.setViewportSize({ width, height });
  await page.evaluate(t => {
    document.documentElement.dataset.experience = "console";
    document.documentElement.dataset.theme = t;
  }, theme);
}

export async function expectFitsViewport(page: Page, width: number) {
  await setConsoleViewport(page, width);
  const info = await page.evaluate(() => {
    const pat = document.querySelector<HTMLElement>("[data-pattern]");
    const offenders = [...document.body.querySelectorAll<HTMLElement>(":scope *")]
      .filter(el => el.getBoundingClientRect().right > window.innerWidth + 0.5)
      .slice(0, 8)
      .map(el => ({
        tag: el.tagName,
        cls: typeof el.className === "string" ? el.className : "",
        right: Math.round(el.getBoundingClientRect().right),
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }));
    return {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      patOverflow: pat ? pat.scrollWidth - pat.clientWidth : 0,
      offenders,
    };
  });
  expect(info.docOverflow, JSON.stringify(info.offenders)).toBeLessThanOrEqual(0);
  expect(info.patOverflow, JSON.stringify(info.offenders)).toBeLessThanOrEqual(0);
}

export async function expectPatternMatrixClean(page: Page) {
  expect(await scanWcag22Matrix(page)).toEqual([]);
  await expectFitsViewport(page, 390);
}
