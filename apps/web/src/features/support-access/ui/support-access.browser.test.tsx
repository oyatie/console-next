// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { chromium, type Browser, type Page } from "@playwright/test";
import { ActiveSupportBanner } from "./support-access";
import appCss from "../../../app.css?inline";
import tokensCss from "@console/tokens/tokens.css?inline";

const supportCss = readFileSync(new URL("./support-access.module.css", import.meta.url), "utf8");
const bannerCss = readFileSync(new URL("../../../ui/banner/banner.module.css", import.meta.url), "utf8");
vi.mock("./support-access.module.css", () => ({ default: new Proxy({}, { get: (_, key) => key }) }));
vi.mock("../../../ui/banner/banner.module.css", () => ({ default: new Proxy({}, { get: (_, key) => key }) }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({}), Link: ({ children }: { children: React.ReactNode }) => <span role="link" tabIndex={0}>{children}</span> }));
const state = vi.hoisted(() => ({ data: {} as unknown }));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<object>(), useQuery: () => ({ data: state.data }) }));

let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog();
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); });

test.each([390, 1440].flatMap((width) => ([
  ["idle", 0, 0], ["pending", 1, 0], ["active", 0, 1], ["crowded", 3, 1],
] as const).map(([name, pending, active]) => ({ width, name, pending, active }))))("$name support notices show every row and action without an inner scroll at $width px", async ({ width, name, pending, active }) => {
  await page.setViewportSize({ width, height: 1000 });
  const session = { id: "active", operator_label: "공급사 · 지원 운영자", expires_at: "2026-10-24T12:00:00Z", request_expires_at: "2026-10-24T12:00:00Z" };
  state.data = { can_approve: true, pending_count: pending, pending_approvals: Array.from({ length: pending }, (_, i) => ({ ...session, id: `pending-${i}` })), sessions: active ? [session] : [] };
  const html = renderToStaticMarkup(<ActiveSupportBanner />);
  await page.setContent(`<!doctype html><html lang="ko"><head><style>${tokensCss}\n${appCss}\n${bannerCss}\n${supportCss}</style></head><body><main>${html}<h1>지원 접근</h1></main></body></html>`);
  const region = page.getByRole("region", { name: "지원 접근", exact: true });
  if (name === "idle") { expect(await region.count()).toBe(0); return; }
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    const bounds = await region.boundingBox();
    expect(await region.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    expect(await region.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
    expect(await region.locator("p").count()).toBe(pending + active);
    for (const element of await region.locator("p, [role=link]").all()) {
      const row = await element.boundingBox();
      expect(row!.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(row!.y + row!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  }
}, 30_000);
