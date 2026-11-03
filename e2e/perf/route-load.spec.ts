// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { vendorPage } from "../flows";
import { routeList } from "../helpers/route-list";
import { budget } from "./budget";
import { buildTenant } from "./fixture";
import { assertBudget, measure, observePaint, reportActivity, summarize } from "./measurement";

test("native collector rejects a held read; unsupported LCP stays unknown", { tag: "@perf" }, async ({ page }) => {
  await page.addInitScript(observePaint);
  const origin = "http://measurement.invalid";
  await page.route(`${origin}/people`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
    <small>Loading</small><script>
      history.replaceState({__TSR_key:'sample'}, '');
      fetch('/api/v1/employees').then(r => r.json()).then(() => {
        document.body.innerHTML = '<main><p style="font-size:40px">${"가상 직원 명부 ".repeat(100)}</p></main><span hidden data-route-ready="/people" data-route-key="sample"></span>';
      });
    </script></body></html>` }));
  await page.route(`${origin}/api/v1/employees`, async route => {
    await new Promise(resolve => setTimeout(resolve, budget.ms + 500));
    await route.fulfill({ json: { items: [] } });
  });
  const sample = await measure(page, `${origin}/people`);
  expect(sample.errors).toEqual([]);
  expect(sample.requests).toEqual({ "GET /api/v1/employees": 1 });
  const supported = await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint"));
  if (supported) expect(sample.lcp_ms).toBeGreaterThan(budget.ms);
  else expect(sample.lcp_ms).toBeNull();
  expect(() => assertBudget(summarize("/people", "cold", Array.from({ length: budget.samples }, () => sample)))).toThrow();
});

test("a previous document's event stream is outside the next load", { tag: "@perf" }, async ({ page }) => {
  let activityStatus = 503;
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/users/me") { response.writeHead(activityStatus).end(); return; }
    if (request.url === "/api/v1/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: ready\n\n");
      return;
    }
    if (request.url === "/api/v1/employees") { response.writeHead(503).end(); return; }
    if (request.url === "/access") { response.writeHead(302, { location: "/access/roles" }).end(); return; }
    if (request.url === "/people/requests") { response.writeHead(302, { location: "/requests" }).end(); return; }
    if (request.url === "/wrong") { response.writeHead(302, { location: "/next" }).end(); return; }
    if (!["/old", "/next", "/bad", "/access/roles", "/requests"].includes(request.url ?? "")) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><main><h1>가상 직원 명부</h1></main><span hidden data-route-ready="${request.url === "/bad" ? "" : request.url}" data-route-key="sample"></span><script>history.replaceState({__TSR_key:'sample'},'');onkeydown=()=>fetch('/api/v1/users/me',{headers:{'x-last-interaction':String(Date.now())}});${request.url === "/old" ? "new EventSource('/api/v1/events');" : request.url === "/bad" ? "fetch('/api/v1/employees').then(() => document.querySelector('[data-route-ready]').dataset.routeReady='/bad');" : ""}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    await page.addInitScript(observePaint);
    const stream = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/events");
    await page.goto(`${origin}/old`);
    await stream;
    const sample = await measure(page, `${origin}/next`);
    expect(sample.errors).toEqual([]);
    expect(sample.requests).toEqual({});
    const activityErrors = await reportActivity(page);
    expect(activityErrors).toEqual(["activity GET /api/v1/users/me 503"]);
    const row = summarize("/next", "warm", Array.from({ length: budget.samples }, () => ({ ...sample, errors: activityErrors })));
    expect(row.status).toBe("unknown");
    expect(() => assertBudget(row)).toThrow();
    activityStatus = 200;
    expect(await reportActivity(page)).toEqual([]);
    await page.evaluate(() => { window.onkeydown = null; });
    page.setDefaultTimeout(250);
    expect(await reportActivity(page)).not.toEqual([]);
    page.setDefaultTimeout(30_000);
    const refused = await measure(page, `${origin}/bad`);
    expect(refused.errors).toContain("GET /api/v1/employees 503");
    expect(await reportActivity(page)).toEqual([]);
    const redirected = await measure(page, `${origin}/access`);
    expect(redirected.errors).toEqual([]);
    expect(redirected.final_path).toBe("/access/roles");
    page.setDefaultTimeout(1000);
    const appForward = await measure(page, `${origin}/people/requests`);
    expect(appForward.errors).toEqual([]);
    expect(appForward.final_path).toBe("/requests");
    const wrong = await measure(page, `${origin}/wrong`);
    expect(wrong.lcp_ms).toBeNull();
    expect(wrong.errors).not.toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("cold and warm route LCP at the synthetic tenant size, with a held-read control", { tag: "@perf" }, async ({ browser }, info) => {
  test.setTimeout(1_200_000);
  expect(process.env.E2E_SERVED, "lab evidence requires the built application").toBe("1");
  const dir = path.resolve(process.env.PERF_EVIDENCE_DIR ?? "");
  expect(process.env.PERF_EVIDENCE_DIR && path.relative(process.cwd(), dir).startsWith(`..${path.sep}`), "PERF_EVIDENCE_DIR must be outside the repository").toBeTruthy();
  const probe = await browser.newPage();
  const supported = await probe.evaluate(() => PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint"));
  await probe.close();
  test.skip(!supported, "This engine does not expose native LCP; no load evidence can be claimed");
  const rows: ReturnType<typeof summarize>[] = [];
  const report = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), run_at: new Date().toISOString(),
    source_command: `E2E_SERVED=1 E2E_PERF=1 E2E_XBROWSER=${browser.browserType().name() === "firefox" ? "1" : "0"} npx playwright test e2e/perf/route-load.spec.ts --project=${info.project.name}`,
    browser: browser.browserType().name(), build: "served", budget, negative_control: {} as object, failure: null as string | null, rows,
  };
  await mkdir(dir, { recursive: true });
  const save = () => writeFile(path.join(dir, "route-load.json"), JSON.stringify(report, null, 2) + "\n");
  let context: BrowserContext | undefined;
  try {
    const { admin, urls } = await test.step("Build the synthetic tenant through product controls", () => buildTenant(browser), { timeout: 1_200_000 });
    test.setTimeout(budget.run_ms);
    const vendor = await vendorPage(browser);
    const states = { tenant: await admin.context().storageState(), vendor: await vendor.context().storageState() };
    const origin = new URL(admin.url()).origin;
    // A setup tab must not later rotate the cookie copied into the measured context.
    await admin.context().close();
    await vendor.context().close();
    const fresh = async (realm: keyof typeof states) => {
      context = await browser.newContext({ storageState: states[realm], baseURL: origin, locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
      context.setDefaultTimeout(30_000);
      await context.addInitScript(observePaint);
      return context.newPage();
    };
    // Hold the document GET so an early shell candidate cannot hide the delayed read from native LCP.
    const control = await fresh("tenant");
    let holds = 0;
    await control.route(`${origin}/`, async route => {
      holds++;
      await new Promise(resolve => setTimeout(resolve, budget.ms + 500));
      await route.continue();
    });
    const held = await measure(control, "/");
    const heldRow = summarize("/", "cold", Array.from({ length: budget.samples }, () => held));
    report.negative_control = { held_ms: budget.ms + 500, holds, sample: held, rejected: false };
    expect(holds).toBeGreaterThan(0);
    expect(held.lcp_ms).toBeGreaterThan(budget.ms);
    expect(() => assertBudget(heldRow)).toThrow();
    report.negative_control = { held_ms: budget.ms + 500, holds, sample: held, rejected: true };
    states.tenant = await context!.storageState();
    await context!.close();
    context = undefined;
    const failures: string[] = [];
    let lastNavigation = 0;
    // Visit the unused operator session before its idle cutoff.
    for (const { path: route } of [...routeList].sort((a, b) => Number(b.path === "/platform") - Number(a.path === "/platform"))) {
      const realm = route === "/platform" ? "vendor" : "tenant";
      const url = urls[route] ?? route;
      const samples = { cold: [] as Awaited<ReturnType<typeof measure>>[], warm: [] as Awaited<ReturnType<typeof measure>>[] };
      if (!url.includes("$")) {
        for (let n = 0; n < budget.samples; n++) {
          const page = await fresh(realm);
          for (const cache of ["cold", "warm"] as const) {
            // Full navigations refresh the same session (60/min); pacing is outside the measured navigation.
            await new Promise(resolve => setTimeout(resolve, Math.max(0, 1050 - (Date.now() - lastNavigation))));
            lastNavigation = Date.now();
            samples[cache].push(await measure(page, url));
          }
          if (realm === "tenant") {
            // Input ends native LCP observation: report real activity only after both samples are captured.
            samples.warm.at(-1)!.errors.push(...await reportActivity(page));
          }
          states[realm] = await context!.storageState();
          await context!.close();
          context = undefined;
          if (samples.cold.at(-1)?.errors.length || samples.warm.at(-1)?.errors.length) break;
        }
      }
      for (const cache of ["cold", "warm"] as const) {
        const row = summarize(route, cache, samples[cache]);
        rows.push(row);
        console.log(`${route} ${cache} p95=${row.lcp_p95_ms ?? "unknown"}ms (${row.sample_count} samples)`);
        try { assertBudget(row); } catch (error) { failures.push((error as Error).message); }
      }
      await save();
    }
    expect(failures, "route-load.json retains every measured route, including reds and unknowns").toEqual([]);
  } catch (error) {
    report.failure = (error as Error).message;
    throw error;
  } finally {
    await context?.close();
    await save();
  }
});
