// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import type { Page, Request } from "@playwright/test";
import { routeReady } from "../flows";
import { routeList } from "../helpers/route-list";
import { budget } from "./budget";

const appPaths = routeList.map(({ path }) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$[A-Za-z]+/g, "[^/]+")}$`));
export const requestKey = (method: string, url: string, body: string | null) => {
  const at = new URL(url);
  return `${method} ${at.pathname}${at.search}${body ? ` body=${JSON.stringify(body)}` : ""}`;
};
export type Sample = { lcp_ms: number | null; ttfb_ms: number | null; longest_task_ms: number | null; ready_ms: number | null; final_path: string | null; requests: Record<string, number>; repeated_requests: string[]; errors: string[] };
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
  const observed = new Map<Request, string>(), active = new Map<Request, string>(), inflight = new Map<string, number>(), repeated = new Set<string>();
  const api = (r: Request) => new URL(r.url()).pathname.startsWith("/api/");
  const requested = (r: Request) => {
    if (!api(r)) return;
    const key = requestKey(r.method(), r.url(), r.postData());
    observed.set(r, key);
    requests[key] = (requests[key] ?? 0) + 1;
    if (r.method() !== "GET" || r.headers()["x-last-interaction"]) return;
    // shortcut: sequential duplicate reads are intentional refetches, instrument query intent if the lab must distinguish them.
    if ((inflight.get(key) ?? 0) > 0) repeated.add(key);
    inflight.set(key, (inflight.get(key) ?? 0) + 1);
    active.set(r, key);
  };
  const finished = (r: Request) => {
    const key = active.get(r);
    if (!key) return;
    const left = (inflight.get(key) ?? 1) - 1;
    if (left) inflight.set(key, left); else inflight.delete(key);
    active.delete(r);
  };
  const failed = (r: Request) => { const key = observed.get(r); if (key) errors.push(`${key} failed`); finished(r); };
  const response = (r: import("@playwright/test").Response) => { const key = observed.get(r.request()); if (key && r.status() >= 400) errors.push(`${key} ${r.status()}`); };
  page.on("request", requested).on("requestfinished", finished).on("requestfailed", failed).on("response", response);
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await routeReady(page);
    const painted = async () => {
      await document.fonts.ready;
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 100))));
    };
    // A committed forwarding component may start another route's reads before its final paint.
    await page.evaluate(painted);
    await routeReady(page);
    await page.evaluate(painted);
    const timing = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const data = (window as unknown as { __routeLoad: { lcp_ms: number | null; longest_task_ms: number | null } }).__routeLoad;
      return { ...data, ttfb_ms: navigation?.responseStart ?? null, ready_ms: performance.now(), final_path: location.pathname };
    });
    if (timing.final_path !== new URL(url, page.url()).pathname && !appPaths.some(path => path.test(timing.final_path))) {
      throw new Error(`unregistered destination ${timing.final_path}`);
    }
    return { ...timing, requests, repeated_requests: [...repeated], errors };
  } catch (error) {
    return { lcp_ms: null, ttfb_ms: null, longest_task_ms: null, ready_ms: null, final_path: null, requests, repeated_requests: [...repeated], errors: [...errors, String(error).split("\n")[0]!] };
  } finally {
    page.off("request", requested).off("requestfinished", finished).off("requestfailed", failed).off("response", response);
  }
}

export function summarize(route: string, cache: "cold" | "warm", samples: Sample[]) {
  const complete = samples.length >= budget.samples && samples.every(s => s.lcp_ms !== null && s.lcp_ms > 0 && s.ttfb_ms !== null && s.ttfb_ms > 0 && !s.errors.length);
  const lcp = samples.flatMap(s => s.lcp_ms === null ? [] : [s.lcp_ms]);
  const n_plus_one = [...new Set(samples.flatMap(s => s.repeated_requests))];
  const compliance = samples.length ? lcp.filter(n => n <= budget.ms).length / samples.length : 0;
  const lcp_p95_ms = percentile(lcp, 0.95);
  const withinBudget = lcp_p95_ms !== null && lcp_p95_ms <= budget.ms && compliance >= budget.target && !n_plus_one.length;
  return { route, cache, environment: "live", ...budget.shape, status: !complete ? "unknown" : withinBudget ? "pass" : "fail",
    lcp_p95_ms, budget_ms: budget.ms, target: budget.target, compliance,
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
