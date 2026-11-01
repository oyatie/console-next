// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";

test("beacon ignores unload-time preloads and still reports after pageshow", async ({ page }) => {
  const reports: { kind: string }[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/v1/client-errors") reports.push(request.postDataJSON());
  });
  await page.route("**/api/v1/client-errors", route => route.fulfill({ status: 204 }));
  // A minimal document loads the shipped, bundle-independent beacon without booting the app.
  await page.route("**/beacon-probe", route => route.fulfill({ contentType: "text/html", body: '<div id="root"><main>probe</main></div><script src="/error-beacon.js"></script>' }));
  await page.goto("/beacon-probe");
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    const error = new TypeError("navigation cancelled a chunk");
    window.dispatchEvent(Object.assign(new Event("vite:preloadError"), { payload: error }));
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: error }));
    // pageshow also fires when a document returns from the browser's back-forward cache.
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(Object.assign(new Event("vite:preloadError"), { payload: new TypeError("real chunk failure") }));
  });
  await expect.poll(() => reports.map(report => report.kind)).toEqual(["preload"]);
});

test("navigating away during a pending module load sends no client-error report", async ({ page }) => {
  const reports: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/v1/client-errors") reports.push(request.postData() ?? "");
  });
  await page.route("**/api/v1/client-errors", route => route.fulfill({ status: 204 }));
  await page.route("**/beacon-pending.js", () => {});
  await page.route("**/beacon-done", route => route.fulfill({ contentType: "text/html", body: "<main>done</main>" }));
  await page.route("**/beacon-probe", route => route.fulfill({ contentType: "text/html", body: `<div id="root"><main>probe</main></div><script src="/error-beacon.js"></script><script type="module">
    import('/beacon-pending.js').catch(error => {
      dispatchEvent(Object.assign(new Event('vite:preloadError'), { payload: error }));
      throw error;
    });
    </script>` }));
  const pending = page.waitForRequest("**/beacon-pending.js");
  await page.goto("/beacon-probe", { waitUntil: "domcontentloaded" });
  await pending;
  await page.goto("/beacon-done");
  expect(reports).toEqual([]);
});
