// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { usePlanKinds } from "./use-plan-kinds";

declare global {
  interface Window {
    planKinds: (...args: Parameters<typeof usePlanKinds>) => ReturnType<typeof usePlanKinds>;
  }
}

let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/plan-kinds-test", logLevel: "error",
    optimizeDeps: { include: ["react", "react-dom/client", "react-dom"] },
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve(".")] } },
    plugins: [{
      name: "plan-kinds-test",
      resolveId: id => id === "/plan-kinds-test.js" ? "\0plan-kinds-test" : undefined,
      load: id => id === "\0plan-kinds-test" ? `
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { usePlanKinds } from '/apps/web/src/features/attendance/ui/use-plan-kinds.ts';
        let latest;
        function Probe({ rows, dates }) { latest = usePlanKinds(rows, dates); return null; }
        const root = createRoot(document.getElementById('root'));
        window.planKinds = (rows, dates) => {
          flushSync(() => root.render(h(Probe, { rows, dates })));
          return latest;
        };
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/plan-kinds-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<div id="root"></div><script type="module" src="/plan-kinds-test.js"></script>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`${server.resolvedUrls!.local[0]}plan-kinds-test`);
  await page.waitForFunction(() => typeof window.planKinds === "function", undefined, { timeout: 10_000 });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test("month and day indexes read rows once, survive rerenders and refresh with live rows or dates", async () => {
  const result = await page.evaluate(() => {
    let reads = 0;
    const dates = ["2026-10-05", "2026-10-06"];
    const rows = [{ employee_id: "person", get cells() { reads++; return [{ plan_kind: "WORK" }, { plan_kind: "REST_DAY" }]; } }];
    const first = window.planKinds(rows, dates);
    const monthReads = reads;
    const again = window.planKinds(rows, dates);
    const values = [first("person|2026-10-05"), first("person|2026-10-06"), first("missing|2026-10-05"), first("person|2026-10-07")];
    const cached = { same: first === again, reads: reads - monthReads, monthReads };
    const changed = window.planKinds([{ employee_id: "person", cells: [{ plan_kind: "NO_SCHEDULE" }] }], dates);
    const shifted = window.planKinds(rows, ["2026-11-05", "2026-11-06"]);
    const dayRows = [{ employee_id: "person", get day() { reads++; return { plan: { kind: "REST_DAY" } }; } }];
    const day = window.planKinds(dayRows, dates[0]!);
    const dayReads = reads;
    const dayAgain = window.planKinds(dayRows, dates[0]!);
    const dayCached = { same: day === dayAgain, reads: reads - dayReads };
    const dayChanged = window.planKinds([{ employee_id: "person", day: { plan: { kind: "WORK" } } }], dates[0]!);
    const tomorrow = window.planKinds(dayRows, dates[1]!);
    const empty = window.planKinds([], dates[0]!);
    return { values, cached, dayCached, updated: changed("person|2026-10-05"),
      shifted: [shifted("person|2026-10-05"), shifted("person|2026-11-05")],
      day: [day("person|2026-10-05"), day("person|2026-10-06"), day("missing|2026-10-05")],
      dayChanged: dayChanged("person|2026-10-05"),
      tomorrow: [tomorrow("person|2026-10-05"), tomorrow("person|2026-10-06")], empty: empty("person|2026-10-05") };
  });
  expect(result.values).toEqual(["WORK", "REST_DAY", undefined, undefined]);
  expect(result.cached).toEqual({ same: true, reads: 0, monthReads: 1 });
  expect(result.dayCached).toEqual({ same: true, reads: 0 });
  expect(result.updated).toBe("NO_SCHEDULE");
  expect(result.shifted).toEqual([undefined, "WORK"]);
  expect(result.day).toEqual(["REST_DAY", undefined, undefined]);
  expect(result.dayChanged).toBe("WORK");
  expect(result.tomorrow).toEqual([undefined, "REST_DAY"]);
  expect(result.empty).toBeUndefined();
});

test.each([2_000, 10_000])("2,000 people × %i draft lookups stay within the interaction budget", async count => {
  const measured = await page.evaluate(draftCount => {
    const dates = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    const rows = Array.from({ length: 2_000 }, (_, i) => ({ employee_id: `person-${i}`, cells: dates.map(() => ({ plan_kind: "WORK" })) }));
    const dayRows = rows.map(row => ({ employee_id: row.employee_id, day: { plan: { kind: "REST_DAY" } } }));
    const keys = Array.from({ length: draftCount }, (_, i) => `person-${i % rows.length}|${dates[Math.floor(i / rows.length)]}`);
    const dayKeys = Array.from({ length: draftCount }, (_, i) => `person-${i % rows.length}|${dates[0]}`);
    const measure = (source: Parameters<typeof window.planKinds>[0], days: Parameters<typeof window.planKinds>[1], drafts: string[], kind: string) => {
      const times: number[] = [];
      let matches = 0;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        const lookup = window.planKinds([...source], days);
        for (let pass = 0; pass < 3; pass++) for (const key of drafts) if (lookup(key) === kind) matches++;
        times.push(performance.now() - start);
      }
      return { median: times.sort((a, b) => a - b)[2]!, matches };
    };
    return { month: measure(rows, dates, keys, "WORK"), day: measure(dayRows, dates[0]!, dayKeys, "REST_DAY") };
  }, count);
  for (const result of [measured.month, measured.day]) {
    expect(result.matches).toBe(count * 3 * 5);
    // Three draft-validation passes plus a cold index must leave room inside the 200 ms INP gate.
    expect(result.median).toBeLessThan(50);
  }
});
