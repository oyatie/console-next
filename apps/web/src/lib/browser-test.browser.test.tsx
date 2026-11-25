// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, openBrowserTestPage, waitForBrowserTestPage, type Browser, type Page } from "./browser-test";

let browser: Browser;
let navigationPage: Page;
let reloadPage: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  navigationPage = await browser.newPage();
  reloadPage = await browser.newPage();
  // Deliberately shorter than fixture loading: readiness belongs to the enclosing hook/test budget.
  for (const page of [navigationPage, reloadPage]) page.setDefaultTimeout(500);
}, 60_000);
afterAll(async () => { await browser?.close(); });

test("fixture navigation waits for its render signal without waiting for unrelated resources", async () => {
  const page = navigationPage;
  const requested = Promise.withResolvers<void>();
  const render = Promise.withResolvers<void>();
  const image = Promise.withResolvers<void>();
  await page.route("https://fixture.test/", route => route.fulfill({ contentType: "text/html", body:
    '<html><title>Fixture</title><div id="root"></div><img src="/pending.png"><script type="module" src="/fixture.js"></script></html>',
  }));
  await page.route("**/fixture.js", async route => {
    requested.resolve();
    await render.promise;
    await route.fulfill({ contentType: "text/javascript", body: 'document.getElementById("root").innerHTML = "<h1>Ready</h1>";' });
  });
  await page.route("**/pending.png", async route => { await image.promise; await route.fulfill({ status: 204 }); });
  let ready = false;
  const opening = openBrowserTestPage(page, "https://fixture.test/", page.getByRole("heading", { name: "Ready" })).then(() => { ready = true; });
  try {
    await requested.promise;
    expect(ready).toBe(false);
    render.resolve();
    await opening;
    expect(await page.evaluate(() => document.readyState)).toBe("interactive");
    expect(await page.evaluate(() => document.fonts.status)).toBe("loaded");
  } finally {
    render.resolve();
    image.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("fixture reload waits for its render signal without waiting for unrelated resources", async () => {
  const page = reloadPage;
  const requested = Promise.withResolvers<void>();
  const render = Promise.withResolvers<void>();
  const image = Promise.withResolvers<void>();
  const url = "https://fixture.test/reload";
  await page.route(url, route => route.fulfill({ contentType: "text/html", body: "<html><title>Initial</title></html>" }));
  await page.goto(url, { waitUntil: "commit", timeout: 0 });
  await page.unroute(url);
  await page.route(url, route => route.fulfill({ contentType: "text/html", body:
    '<html><title>Reload</title><div id="root"></div><img src="/reload-pending.png"><script type="module" src="/reload.js"></script></html>',
  }));
  await page.route("**/reload.js", async route => {
    requested.resolve();
    await render.promise;
    await route.fulfill({ contentType: "text/javascript", body: 'document.getElementById("root").innerHTML = "<h1>Ready</h1>";' });
  });
  await page.route("**/reload-pending.png", async route => { await image.promise; await route.fulfill({ status: 204 }); });
  try {
    await page.reload({ waitUntil: "commit", timeout: 0 });
    await requested.promise;
    let ready = false;
    const opening = waitForBrowserTestPage(page, page.getByRole("heading", { name: "Ready" })).then(() => { ready = true; });
    await page.evaluate(() => document.readyState);
    expect(ready).toBe(false);
    render.resolve();
    await opening;
    expect(ready).toBe(true);
    expect(await page.evaluate(() => document.readyState)).toBe("interactive");
    expect(await page.evaluate(() => document.fonts.status)).toBe("loaded");
  } finally {
    render.resolve();
    image.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("fixture readiness settles every font face, including one no drawn text has asked for yet", async () => {
  const page = await browser.newPage();
  const face = resolve("node_modules/pretendard/dist/web/variable/woff2-dynamic-subset/PretendardVariable.subset.0.woff2");
  const requested = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  await page.route("https://fixture.test/fonts", route => route.fulfill({ contentType: "text/html", body:
    '<html><style>@font-face{font-family:Drawn;src:url(/drawn.woff2)}@font-face{font-family:Later;src:url(/later.woff2)}</style><h1 style="font-family:Drawn">Ready</h1></html>',
  }));
  await page.route("**/drawn.woff2", route => route.fulfill({ path: face }));
  await page.route("**/later.woff2", async route => { requested.resolve(); await held.promise; await route.fulfill({ path: face }); });
  let ready = false;
  const opening = openBrowserTestPage(page, "https://fixture.test/fonts", page.getByRole("heading", { name: "Ready" })).then(() => { ready = true; });
  try {
    await requested.promise;
    await page.evaluate(() => document.readyState);
    expect(ready).toBe(false);
    held.resolve();
    await opening;
    expect(await page.evaluate(() => [...document.fonts].map(f => `${f.family}:${f.status}`))).toEqual(["Drawn:loaded", "Later:loaded"]);
  } finally {
    held.resolve();
    await page.close();
  }
});
