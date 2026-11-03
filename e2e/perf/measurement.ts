// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import type { Page, Request } from "@playwright/test";
import { routeReady } from "../flows";
import { redirectTargets } from "../helpers/route-list";
import { budget, readYaml } from "./budget";

const contract = readYaml(new URL("../../backend/openapi/openapi.yaml", import.meta.url)) as { paths: Record<string, unknown> };
const templates = Object.keys(contract.paths).sort((a, b) => a.split("{").length - b.split("{").length)
  .map(path => ({ path, re: new RegExp(`^${path.split(/(\{[^}]+\})/).map(p => p.startsWith("{") ? "[^/]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`) }));
export const templatePath = (path: string) => templates.find(t => t.re.test(path))?.path ?? path;
export type Sample = { lcp_ms: number | null; ttfb_ms: number | null; longest_task_ms: number | null; ready_ms: number | null; final_path: string | null; requests: Record<string, number>; errors: string[] };
export const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null;

/** Installed before navigation; never substitute readiness, FCP or a shell timestamp for LCP. */
export function observePaint() {
  const data = { lcp_ms: null as number | null, longest_task_ms: PerformanceObserver.supportedEntryTypes.includes("longtask") ? 0 : null as number | null };
  (window as unknown as { __routeLoad: typeof data }).__routeLoad = data;
  for (const type of ["largest-contentful-paint", "longtask"]) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (type === "largest-contentful-paint") data.lcp_ms = entry.startTime;
        else data.longest_task_ms = Math.max(data.longest_task_ms ?? 0, entry.duration);
      }
    }).observe({ type, buffered: true });
  }
}

export async function measure(page: Page, url: string): Promise<Sample> {
  const requests: Record<string, number> = {}, errors: string[] = [];
  const observed = new Set<Request>();
  const api = (r: Request) => new URL(r.url()).pathname.startsWith("/api/");
  const key = (r: Request) => `${r.method()} ${templatePath(new URL(r.url()).pathname)}`;
  const requested = (r: Request) => { if (api(r)) { observed.add(r); requests[key(r)] = (requests[key(r)] ?? 0) + 1; } };
  const failed = (r: Request) => { if (observed.has(r)) errors.push(`${key(r)} failed`); };
  const response = (r: import("@playwright/test").Response) => { if (observed.has(r.request()) && r.status() >= 400) errors.push(`${key(r.request())} ${r.status()}`); };
  page.on("request", requested).on("requestfailed", failed).on("response", response);
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await routeReady(page, redirectTargets[new URL(url, page.url()).pathname] ?? url);
    await page.evaluate(() => document.fonts.ready);
    // Let the committed screen paint and the buffered observer deliver its final candidate.
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 100)))));
    const timing = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const data = (window as unknown as { __routeLoad: { lcp_ms: number | null; longest_task_ms: number | null } }).__routeLoad;
      return { ...data, ttfb_ms: navigation?.responseStart ?? null, ready_ms: performance.now(), final_path: location.pathname };
    });
    return { ...timing, requests, errors };
  } catch (error) {
    return { lcp_ms: null, ttfb_ms: null, longest_task_ms: null, ready_ms: null, final_path: null, requests, errors: [...errors, String(error).split("\n")[0]!] };
  } finally {
    page.off("request", requested).off("requestfailed", failed).off("response", response);
  }
}

export function summarize(route: string, cache: "cold" | "warm", samples: Sample[]) {
  const complete = samples.length >= budget.samples && samples.every(s => s.lcp_ms !== null && s.lcp_ms > 0 && s.ttfb_ms !== null && s.ttfb_ms > 0 && !s.errors.length);
  const lcp = samples.flatMap(s => s.lcp_ms === null ? [] : [s.lcp_ms]);
  const n_plus_one = [...new Set(samples.flatMap(s => Object.entries(s.requests).filter(([key, n]) => key.startsWith("GET ") && n > 1).map(([key]) => key)))];
  const compliance = samples.length ? lcp.filter(n => n <= budget.ms).length / samples.length : 0;
  return { route, cache, environment: "live", ...budget.shape, status: complete ? "pass" : "unknown",
    lcp_p95_ms: percentile(lcp, 0.95), budget_ms: budget.ms, target: budget.target, compliance,
    n_plus_one, sample_count: samples.length, samples };
}

export function assertBudget(row: ReturnType<typeof summarize>) {
  assert(row.status === "pass" && row.lcp_p95_ms !== null && row.lcp_p95_ms <= budget.ms && row.compliance >= budget.target && !row.n_plus_one.length,
    `${row.route} ${row.cache}: p95=${row.lcp_p95_ms ?? "unknown"}ms, compliance=${row.compliance}, N+1=${row.n_plus_one.join(", ")}, status=${row.status}`);
}

/** A failed activity read invalidates this pair; later routes must still be measured. */
export async function reportActivity(page: Page): Promise<string[]> {
  try {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/v1/users/me" && !!r.request().headers()["x-last-interaction"]),
      page.keyboard.press("Shift"),
    ]);
    return response.status() === 200 ? [] : [`activity GET /api/v1/users/me ${response.status()}`];
  } catch (error) {
    return [`activity GET /api/v1/users/me: ${String(error).split("\n")[0]}`];
  }
}
