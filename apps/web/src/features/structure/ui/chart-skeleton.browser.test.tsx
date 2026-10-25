// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { chromium, type Browser, type Page } from "../../../lib/browser-test";
import { loadCatalog } from "@console/i18n";
import { ChartSkeleton } from "./chart-skeleton";

vi.mock("./chart.module.css", () => ({ default: new Proxy({}, { get: (_, key) => key }) }));
const appCss = readFileSync(resolve("packages/tokens/tokens.css"), "utf8") + readFileSync(resolve("apps/web/src/app.css"), "utf8").replace(/^@import .*;$/gm, "");
let browser: Browser;
let pages: [Page, Page];
beforeAll(async () => {
  await loadCatalog("ko");
  browser = await chromium.launch();
  pages = await Promise.all([
    browser.newPage({ viewport: { width: 1440, height: 900 } }),
    browser.newPage({ viewport: { width: 390, height: 900 } }),
  ]);
}, 60_000);
afterAll(async () => { await browser?.close(); });

test.each([1440, 390])("the chart placeholder reserves the chart canvas height at %spx", async width => {
  const page = pages[width === 1440 ? 0 : 1];
  const chartCss = readFileSync(new URL("./chart.module.css", import.meta.url), "utf8");
  try {
    await page.setContent(`<!doctype html><html lang="ko"><head><style>${appCss}\n${chartCss}</style></head><body>${renderToStaticMarkup(<ChartSkeleton />)}<div class="chartWrap"></div></body></html>`);
    const placeholder = (await page.locator(".skeleton").boundingBox())!.height;
    const canvas = (await page.locator(".chartWrap").boundingBox())!.height;
    expect(placeholder).toBeGreaterThan(0);
    expect(Math.abs(placeholder - canvas)).toBeLessThanOrEqual(1);
  } finally { await page.close(); }
});
