// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { mockRoute } from "./route";
import { AT, authz, checklist, employees, facets, failure, id, inbox, structure, token, user } from "./fixtures";
import { orgChange, orgChanges } from "./org-changes";
import type { OrgChangeState, Screen, State } from "../states/registry";

/** Complete, isolated shell + screen. Any unregistered API request fails the test instead of hitting a server. */
export async function mockScreen(page: Page, screen: Screen, state: State | OrgChangeState) {
  if (process.env.E2E_CPU_THROTTLE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.E2E_CPU_THROTTLE) });
  }
  const unexpected: string[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 501, json: failure("unmocked_request") });
  });
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: token() });
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: user });
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: authz });
  await mockRoute(page, "get", "/api/v1/support-sessions/active", { status: 200, json: { sessions: [], pending_count: 0, pending_approvals: [], can_approve: false } });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: checklist });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/regions", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/branches", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/workplace-kinds", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/access/granters", { status: 200, json: { count: 1, names: ["김권한담당"] } });
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { account_id: user.id, is_ops: false, phase: "OPERATING", as_of: AT, entries: [] } });
  await mockRoute(page, "get", "/api/v1/org-structure/change-dates", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { items: [] } });
  // route.fulfill buffers bodies; a browser stream keeps the shell healthy without fake reconnects.
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        request.signal.addEventListener("abort", () => controller.close(), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }));
    };
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const count = state === "empty" ? 0 : state === "large" ? 2000 : 3;
  const rows = employees(count, state === "long");
  const queue = inbox(count, state === "long");
  const tree = structure(count, state === "long");
  // Register hover/focus detail prefetch before facets: Playwright tries later routes first.
  await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 404, json: failure("not_found") });
  await mockRoute(page, "get", "/api/v1/employees/facets", { status: 200, json: facets(count) });
  const error = state === "failed" ? { status: 503 as const, json: failure("service_unavailable") } : state === "refused" ? { status: 403 as const, json: failure("forbidden") } : null;
  const beforeReply = async (path: Screen["read"]) => {
    if (path !== screen.read) return null;
    if (state === "loading") await held;
    return error;
  };
  await mockRoute(page, "get", "/api/v1/employees", async request => {
    const failed = await beforeReply("/api/v1/employees");
    const query = new URL(request.url()).searchParams;
    const cursor = query.get("cursor");
    const offset = cursor ? rows.findIndex(row => row.id === cursor) + 1 : 0;
    const limit = Number(query.get("limit") ?? 100), end = offset + limit;
    return failed ?? { status: 200, json: { items: rows.slice(offset, end), total: count, offset, limit, next_cursor: end < count ? rows[end - 1]!.id : null } };
  });
  await mockRoute(page, "get", "/api/v1/me/action-inbox", async request => {
    const failed = await beforeReply("/api/v1/me/action-inbox");
    const offset = Number(new URL(request.url()).searchParams.get("cursor") ?? 0);
    const end = offset + 100;
    return failed ?? { status: 200, json: { ...queue, items: queue.items.slice(offset, end), next_cursor: end < count ? String(end) : null } };
  });
  await mockRoute(page, "get", "/api/v1/org-structure", async () => (await beforeReply("/api/v1/org-structure")) ?? { status: 200, json: tree });
  const changes = orgChanges(screen.key === "org-changes" ? count : 0, state === "long");
  await mockRoute(page, "get", "/api/v1/org-changes", async request => {
    const failed = await beforeReply("/api/v1/org-changes");
    const query = new URL(request.url()).searchParams;
    const statuses = query.getAll("status").flatMap(value => value.split(","));
    const filtered = changes.filter(row => (!statuses.length || statuses.includes(row.status)) && (!query.has("drafted_by") || row.draftedBy === query.get("drafted_by")) && (!query.has("effective_from") || row.effectiveDate >= query.get("effective_from")!) && (!query.has("effective_to") || row.effectiveDate <= query.get("effective_to")!));
    const offset = Number(query.get("offset") ?? 0), limit = Number(query.get("limit") ?? 50);
    return failed ?? { status: 200, json: { items: filtered.slice(offset, offset + limit), total: filtered.length } };
  });
  const record = orgChange(state === "empty" ? "populated" : state);
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", async () => (await beforeReply("/api/v1/org-changes/{id}")) ?? (state === "missing" ? { status: 404, json: failure("not_found") } : { status: 200, json: record }));
  await mockRoute(page, "post", "/api/v1/org-changes/{id}/preflight", { status: 200, json: record });
  return { unexpected, release, count, operationId: id(99) };
}
