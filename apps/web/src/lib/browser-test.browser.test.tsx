// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, openBrowserTestPage, type Browser, type Page } from "./browser-test";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  // Deliberately shorter than fixture loading: readiness belongs to the enclosing hook/test budget.
  page.setDefaultTimeout(500);
}, 60_000);
afterAll(async () => { await browser?.close(); });

test("fixture navigation waits for its render signal without waiting for unrelated resources", async () => {
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
