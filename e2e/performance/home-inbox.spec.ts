// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { components } from "@console/api/schema";
import { COMPANY, importPeople } from "../people-directory.fixture";
import { tenantWithExecutive } from "../setup-flows";
import { apiOf, bearerOf, headcount } from "../helpers/api";
import { seedUnlockReview } from "./sole-unlock-fixture";

test("served 2,000-person Home and its inbox stay within 2 seconds under burst", { tag: ["@hr", "@performance"] }, async ({ browser }, info) => {
  test.skip(process.env.E2E_SERVED !== "1", "Requires the served production web build");
  test.setTimeout(600_000);
  const { admin, exec } = await tenantWithExecutive(browser, "homeperf", COMPANY);
  try {
    const bearer = bearerOf(admin);
    await importPeople(admin);
    const api = apiOf(admin, bearer);
    expect(await headcount(api)).toBe(2000);
    const review = seedUnlockReview(bearer());
    const settings = await api("/settings");
    expect(settings.status()).toBe(200);
    const { items } = await settings.json() as { items: { key: string; value: unknown }[] };
    const configured = items.find(i => i.key === "action_inbox.source_concurrency")?.value;
    const permits = Number(process.env.CONSOLE_ACTION_INBOX_SOURCE_CONCURRENCY ?? configured);
    expect(permits).toBeGreaterThan(0);
    await admin.setViewportSize({ width: 1440, height: 900 });
    await admin.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const row = document.querySelector('[aria-labelledby="inbox-title"] [data-id]');
        if (!row?.textContent?.trim()) return;
        observer.disconnect();
        requestAnimationFrame(() => performance.mark("home:first-rows"));
      });
      observer.observe(document, { subtree: true, childList: true });
    });
    let arrivalReads = 0;
    const isArrival = (message: { url(): string }) => {
      const url = new URL(message.url());
      return url.pathname === "/api/v1/me/action-inbox" && url.searchParams.get("filter") === "turn" && !url.searchParams.has("cursor");
    };
    admin.on("request", request => { if (isArrival(request)) arrivalReads++; });
    const samples: { run: number; arrivalReads: number; responseStart: number; firstRows: number; inbox: number }[] = [];
    for (let run = 1; run <= 3; run++) {
      // The header badge on the previous page makes the same read; leave that page first so a late reply cannot stand in for this load's.
      await admin.goto("about:blank");
      arrivalReads = 0;
      const burst = admin.waitForRequest(isArrival).then(() => Promise.all(Array.from({ length: permits }, () => api("/me/action-inbox?filter=turn&attention=all"))));
      const inbox = admin.waitForResponse(isArrival);
      await admin.goto("/");
      const response = await inbox;
      expect(response.status()).toBe(200);
      const body = await response.json() as components["schemas"]["ActionInboxResponse"];
      expect(body.unavailable).toEqual([]);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.some(item => item.id === `period_unlock:${review}`)).toBe(true);
      if (run === 1) {
        expect(body.next_cursor, "2,000 people require a continuation").not.toBeNull();
        const continuation = await api(`/me/action-inbox?limit=50&cursor=${encodeURIComponent(body.next_cursor!)}`);
        expect(continuation.status()).toBe(200);
        const next = await continuation.json() as components["schemas"]["ActionInboxResponse"];
        expect(next.unavailable).toEqual([]);
        expect(next.as_of).toBe(body.as_of);
        const firstIds = new Set(body.items.map(item => item.id));
        expect(next.items.length).toBeGreaterThan(0);
        expect(next.items.every(item => !firstIds.has(item.id))).toBe(true);
      }
      await expect(admin.getByRole("region", { name: "업무함", exact: true }).locator("[data-id]").first()).toBeVisible();
      await admin.waitForFunction(() => performance.getEntriesByName("home:first-rows").length > 0);
      const timing = await admin.evaluate(() => {
        const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        const resource = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find(r => new URL(r.name).pathname === "/api/v1/me/action-inbox");
        return { responseStart: navigation.responseStart, firstRows: performance.measure("home:response-to-first-rows", { start: navigation.responseStart, end: "home:first-rows" }).duration, inbox: resource?.duration ?? 0 };
      });
      for (const reply of await burst) {
        expect(reply.status()).toBe(200);
        expect((await reply.json() as components["schemas"]["ActionInboxResponse"]).unavailable).toEqual([]);
      }
      samples.push({ run, arrivalReads, ...timing });
    }
    const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
    const summary = Object.fromEntries(["inbox", "firstRows"].map(key => {
      const values = samples.map(s => key === "inbox" ? s.inbox : s.firstRows);
      return [key, { median: percentile([...values], 0.5), p95: percentile([...values], 0.95) }];
    }));
    const report = { employees: 2000, buildProfile: "production-web", configuredPermits: permits, burstRequests: permits, budgetMs: 2000, samples, summary };
    const reportPath = info.outputPath("home-inbox-performance.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await info.attach("home-inbox-performance", { path: reportPath, contentType: "application/json" });
    console.log(JSON.stringify(report));
    for (const sample of samples) {
      expect(sample.arrivalReads).toBe(1);
      expect(sample.responseStart).toBeGreaterThan(0);
      expect(sample.inbox).toBeGreaterThan(0);
      expect(sample.inbox).toBeLessThanOrEqual(report.budgetMs);
      expect(sample.firstRows).toBeLessThanOrEqual(report.budgetMs);
    }
  } finally {
    await admin.context().close();
    await exec.context().close();
  }
});
