// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";

test("the served SPA returns an uncached 404 for a missing bundle", async ({ page, request }) => {
  test.skip(process.env.E2E_SERVED !== "1", "static serving requires the backend-served SPA");
  const missing = "/assets/spa-serving-missing.js";
  expect((await page.goto("/"))?.status()).toBe(200);
  const bundle = await page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, body: await response.text() };
  }, missing);
  expect(bundle).toEqual({ status: 404, body: "" });
  for (const method of ["GET", "HEAD"]) {
    const response = await request.fetch(missing, { method, headers: { "if-none-match": "*" } });
    expect(response.status()).toBe(404);
    expect(response.headers()["cache-control"]).toBe("no-cache");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers().etag).toBeUndefined();
    expect(await response.body()).toHaveLength(0);
  }
});
