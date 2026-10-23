// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "@playwright/test";
import { SetupRail } from "./setup-rail";
import appCss from "../../app.css?inline";
const railCss = readFileSync(new URL("./setup-rail.module.css", import.meta.url), "utf8");

vi.mock("./setup-rail.module.css", () => ({ default: new Proxy({}, { get: (_, key) => key }) }));
vi.mock("@console/i18n", () => ({ t: (key: string) => key }));
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
}, 60_000);
afterAll(async () => { await browser?.close(); });

test("setup actions fit at 390px and leave room for the step title", async () => {
  const action = "담당자 정하기", later = "담당자는 나중에";
  const html = renderToStaticMarkup(<SetupRail title="시작하기" groups={[{ key: "ops", title: "운영 준비", steps: [{
    key: "approval", title: "승인 담당자를 정합니다", state: "todo", detail: "승인할 담당자를 정해 주세요.",
    action: <button className="btn btn--primary">{action}</button>,
    secondary: <button className="btn btn--ghost">{later}</button>,
  }] }]} />);
  await page.setContent(`<!doctype html><html lang="ko"><head><style>${appCss}\n${railCss}</style></head><body><main style="padding:24px">${html}</main></body></html>`);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    expect(await page.locator("[data-step]").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
    const title = await page.locator("[data-step] > span").first().boundingBox();
    const actions = await page.getByRole("button", { name: "담당자 정하기" }).boundingBox();
    expect(actions!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  }
}, 30_000);
