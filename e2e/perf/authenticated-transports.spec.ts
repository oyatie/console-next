// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { vendorPage } from "../flows";
import { budget } from "./budget";
import { measure, observePaint, summarize, type Sample } from "./measurement";
import { launchHTTP1 } from "./transport";

test("both HTTPS transports refresh authentication and return complete rows", { tag: "@perf" }, async ({ browser, baseURL }, info) => {
  test.setTimeout(300_000);
  expect(new URL(baseURL!).protocol).toBe("https:");
  const vendor = await vendorPage(browser);
  // Stop setup-page refreshes while the measured contexts rotate this session's cookie.
  await vendor.goto("about:blank");
  let state = await vendor.context().storageState();
  const h1 = await launchHTTP1(browser);
  const rows = [];
  let lastNavigation = 0;
  try {
    for (const [engine, protocol] of [[h1, "http/1.1"], [browser, "h2"]] as const) {
      const samples: Record<"cold" | "warm", Sample[]> = { cold: [], warm: [] };
      for (let n = 0; n < budget.samples; n++) {
        const context = await engine.newContext({ baseURL, storageState: state, ignoreHTTPSErrors: true, serviceWorkers: "block" });
        try {
          await context.addInitScript(observePaint);
          const page = await context.newPage();
          for (const cache of ["cold", "warm"] as const) {
            await new Promise(resolve => setTimeout(resolve, Math.max(0, 1050 - (Date.now() - lastNavigation))));
            lastNavigation = Date.now();
            const sample = await measure(page, "/platform", cache === "cold" ? protocol : undefined);
            expect(sample.errors).toEqual([]);
            expect(Object.keys(sample.requests).some(key => key.startsWith("POST /api/v1/auth/token/refresh"))).toBe(true);
            samples[cache].push(sample);
          }
        } finally { state = await context.storageState(); await context.close(); }
      }
      for (const cache of ["cold", "warm"] as const) {
        const row = { ...summarize("/platform", cache, samples[cache]), protocol };
        rows.push(row);
        expect(row.sample_count).toBe(budget.samples);
        expect(row.status).not.toBe("unknown");
      }
    }
  } finally {
    await h1.close();
    await vendor.context().addCookies(state.cookies);
    await info.attach("transport-completeness.json", { body: JSON.stringify(rows), contentType: "application/json" });
  }
});
