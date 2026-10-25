// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { QueryState } from "./query-state";
import { Dialog } from "../../ui/dialog";
import { Denied } from "./denied";
import { grantersQuery, myAccessQuery } from "../../reference/authz/api";

vi.mock("../../ui/skeleton/skeleton.module.css", () => ({ default: new Proxy({}, { get: (_, key) => key }) }));
vi.mock("./denied.module.css", () => ({ default: new Proxy({}, { get: (_, key) => key }) }));
// Expose the portal's markup to SSR; the browser still measures the shared Dialog and its real CSS.
vi.mock("react-aria-components", async original => {
  const Surface = ({ children, className }: { children: ReactNode; className: string }) => <div className={className}>{children}</div>;
  return { ...await original<object>(), ModalOverlay: Surface, Modal: Surface, Dialog: Surface,
    Heading: ({ children, className }: { children: ReactNode; className: string }) => <h2 className={className}>{children}</h2> };
});
const appCss = readFileSync(resolve("packages/tokens/tokens.css"), "utf8") + readFileSync(new URL("../../app.css", import.meta.url), "utf8").replace(/^@import .*;$/gm, "");
const skeletonCss = readFileSync(new URL("../../ui/skeleton/skeleton.module.css", import.meta.url), "utf8");
const deniedCss = readFileSync(new URL("./denied.module.css", import.meta.url), "utf8");

let browser: Browser;
let pages: [Page, Page, Page, Page, Page];
beforeAll(async () => {
  await loadCatalog("ko");
  browser = await chromium.launch();
  pages = await Promise.all([
    browser.newPage({ viewport: { width: 1440, height: 900 } }),
    browser.newPage({ viewport: { width: 390, height: 900 } }),
    browser.newPage({ viewport: { width: 390, height: 900 } }),
    browser.newPage({ viewport: { width: 1440, height: 900 } }),
    browser.newPage({ viewport: { width: 390, height: 900 } }),
  ]);
}, 60_000);
afterAll(async () => { await browser?.close(); });

async function markup(content: ReactNode) {
  const client = new QueryClient();
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: false, entries: [] }) });
  await client.fetchQuery({ ...grantersQuery, queryFn: async () => ({ count: 1, names: ["권한 담당자"] }) });
  const root = createRootRoute({ component: () => content });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

test.each([1440, 390])("a dialog read keeps its height through loading, failure, retry and ready at %spx", async width => {
  const page = pages[width === 1440 ? 0 : 1];
  try {
    const heights = [];
    for (const state of ["loading", "failed", "loading", "ready"] as const) {
      const ready = state === "ready";
      const content = await markup(<Dialog open read title={t("statutory.complete")} onClose={() => {}}><QueryState q={{ isPending: state === "loading", error: state === "failed" ? new ApiError(503, "unavailable", "", [], "read-reference") : null, data: ready ? true : undefined, refetch: () => {} }}>{() => <form className="form">
        <p>{t("statutory.openingHold")}</p><p>{t("statutory.target")}</p><p>{t("statutory.basis")}</p>
        <label>{t("statutory.resolution")}<select><option>{t("statutory.complete")}</option></select></label>
        <div className="row"><button className="btn">{t("statutory.cancel")}</button><button className="btn">{t("statutory.preview")}</button></div>
      </form>}</QueryState></Dialog>);
      if (!heights.length) await page.setContent(`<!doctype html><html lang="ko"><head><style>${appCss}\n${skeletonCss}</style></head><body></body></html>`);
      await page.locator("body").evaluate((element, html) => { element.innerHTML = html; }, content);
      heights.push((await page.locator(".dialog").boundingBox())!.height);
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally { await page.close(); }
});

test.each([1440, 390])("a form-only dialog keeps its content height at %spx", async width => {
  const page = pages[width === 1440 ? 3 : 4];
  try {
    const content = await markup(<Dialog open title={t("roster.export.title")} onClose={() => {}}><form className="form">
      <label>{t("statutory.reasonEvidence")}<input /></label>
      <div className="row"><button className="btn">{t("common.back")}</button><button className="btn">{t("roster.export")}</button></div>
    </form></Dialog>);
    await page.setContent(`<!doctype html><html lang="ko"><head><style>${appCss}</style></head><body>${content}</body></html>`);
    const height = (await page.locator(".dialog").boundingBox())!.height;
    await page.locator(".dialog__body").evaluate(body => { (body as HTMLElement).style.minBlockSize = "auto"; });
    const contentHeight = (await page.locator(".dialog").boundingBox())!.height;
    expect(Math.abs(height - contentHeight)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  } finally { await page.close(); }
});

test("the refusal separates the held grants label from its value", async () => {
  const page = pages[2];
  try {
    const content = await markup(<Denied />);
    await page.setContent(`<!doctype html><html lang="ko"><head><style>${appCss}\n${deniedCss}</style></head><body>${content}</body></html>`);
    const label = await page.getByText(t("common.denied.mine"), { exact: true }).boundingBox();
    const value = await page.getByText(t("common.denied.mine.none"), { exact: true }).boundingBox();
    expect(value!.y).toBeGreaterThan(label!.y + label!.height);
  } finally { await page.close(); }
});
