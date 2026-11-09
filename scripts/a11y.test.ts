// SPDX-License-Identifier: LicenseRef-Proprietary
import AxeBuilder from "@axe-core/playwright";
import { chromium, firefox, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expectAxe } from "../e2e/a11y";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await (process.env.E2E_XBROWSER === "1" ? firefox : chromium).launch();
  const context = await browser.newContext();
  page = await context.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); });

test.each(["none", "existing", "appears"])("state accessibility scans preserve rules, themes and %s frames without unnecessary pages", async frame => {
  await page.setContent(`<!doctype html><html lang="ko" data-theme="dark"><head><title>접근성 검사</title><style>button { min-height: 44px; margin: 4px; }</style></head>
    <body><main><h1>작업</h1>${Array.from({ length: 100 }, (_, i) => `<button>작업 ${i + 1}</button>`).join("")}
    <div role="directory">목록 1</div><div role="directory">목록 2</div></main></body></html>`);
  await page.route("https://accessibility-frame.test/", route => route.fulfill({ contentType: "text/html; charset=utf-8", body:
    '<html lang="ko"><head><title>목록</title></head><body><div role="directory">목록 3</div><div role="directory">목록 4</div></body></html>',
  }));
  const addFrame = async () => {
    await page.evaluate(() => {
      const child = document.createElement("iframe");
      child.title = "목록";
      child.src = "https://accessibility-frame.test/";
      document.body.append(child);
    });
    await page.frameLocator("iframe").getByText("목록 3", { exact: true }).waitFor();
  };
  if (frame !== "none") await addFrame();
  const reference = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(reference.passes.some(rule => rule.nodes.length > 1)).toBe(true);
  expect(reference.violations.find(rule => rule.id === "aria-deprecated-role")?.nodes).toHaveLength(frame === "none" ? 2 : 4);
  if (frame === "appears") await page.locator("iframe").evaluate(el => el.remove());
  const scans = new Map<string | null, typeof reference>();
  const analyze = AxeBuilder.prototype.analyze;
  let pages = 0, attached = false;
  const opened = () => { pages++; };
  page.context().on("page", opened);
  AxeBuilder.prototype.analyze = async function () {
    const results = await analyze.call(this);
    scans.set(await page.locator("html").getAttribute("data-theme"), results);
    if (frame === "appears" && !attached) { attached = true; await addFrame(); }
    return results;
  };
  try {
    await expectAxe(page, "passing controls");
  } finally {
    AxeBuilder.prototype.analyze = analyze;
    page.context().off("page", opened);
  }
  if (frame === "none") expect(pages).toBe(0);
  expect([...scans.keys()]).toEqual(["light", "dark"]);
  for (const results of scans.values()) {
    expect(results.violations).toEqual(reference.violations);
    expect(results.passes.map(rule => rule.id)).toEqual(reference.passes.map(rule => rule.id));
    expect(results.passes.every(rule => rule.nodes.length <= 1)).toBe(true);
  }
  expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
});
