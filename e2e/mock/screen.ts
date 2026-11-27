// SPDX-License-Identifier: LicenseRef-Proprietary
import { REALTIME } from "../../apps/web/src/lib/freshness";
import { installFaultClock } from "../states/fault-clock";
import type { Page } from "@playwright/test";
import { attendanceBoardReads } from "./attendance-board";
import { attendanceBoardScreens } from "../states/attendance";
import { mockRoute } from "./route";
import { AT, authz, checklist, employees, facets, failure, id, inbox, modules, screenAccess, structure, token, user } from "./fixtures";
import { orgChange, orgChanges } from "./org-changes";
import { mockOrgChangeCounts } from "./org-changes-web";
import { mockPayroll } from "./payroll";
import type { PayrollState, OrgChangeState, Screen, State } from "../states/registry";
import { mockLifecycleSheets } from "./lifecycle-sheets";
import { numberingReads } from "./numbering";
import { mockDirectorySettings } from "./directory";
import { throttleCPU } from "../helpers/cpu-throttle";

export async function mockEventStream(page: Page) {
  // route.fulfill buffers bodies; a browser stream keeps the shell healthy without fake reconnects.
  await page.addInitScript(heartbeatInterval => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        const ping = () => controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        ping();
        const timer = setInterval(ping, heartbeatInterval);
        request.signal.addEventListener("abort", () => { clearInterval(timer); controller.close(); }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }));
    };
  }, REALTIME.heartbeatInterval);
}

/** Complete, isolated shell + screen. Any unregistered API request fails the test instead of hitting a server. */
export async function mockScreen(page: Page, screen: Screen, state: State | OrgChangeState | PayrollState, modulesState: keyof typeof modules | "refused" = "ready") {
  if (state === "failed") await installFaultClock(page);
  await throttleCPU(page);
  const unexpected: string[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 501, json: failure("unmocked_request") });
  });
  await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: token() });
  await page.route("**/api/v1/client-errors", route => route.fulfill({ status: 204 }));
  await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: user });
  await mockRoute(page, "post", "/api/v1/users/me/employee-link/prepare", { status: 403, json: failure("account_link.refuse.solo_ineligible") });
  await page.route("**/api/v1/users/me/employee-link", route => route.request().method() === "GET"
    ? route.fulfill({ json: { attestation: null } }) : route.fallback());
  await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: authz });
  let workspaceLayout: Record<string, unknown> = {};
  await mockRoute(page, "get", "/api/v1/me/workspace", () => ({ status: 200, json: { layout: workspaceLayout } }));
  await mockRoute(page, "put", "/api/v1/me/workspace", request => {
    const body = request.postDataJSON() as { layout?: Record<string, unknown> };
    workspaceLayout = body?.layout ?? {};
    return { status: 200, json: { layout: workspaceLayout } };
  });
  await mockRoute(page, "get", "/api/v1/support-sessions/active", { status: 200, json: { sessions: [], pending_count: 0, pending_approvals: [], can_approve: false } });
  await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: checklist });
  await mockRoute(page, "get", "/api/v1/onboarding/modules", modulesState === "refused"
    ? { status: 403, json: failure("forbidden") } : { status: 200, json: modules[modulesState] });
  await mockRoute(page, "get", "/api/v1/legal-entities", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/org-units", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/regions", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/branches", { status: 200, json: [] });
  await mockRoute(page, "get", "/api/v1/workplace-kinds", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/access/granters", { status: 200, json: { count: 1, names: ["김권한담당"] } });
  await mockRoute(page, "get", "/api/v1/access/me", request => ({ status: 200,
    json: screenAccess(new URL(request.headers().referer ?? request.url()).pathname),
  }));
  await mockRoute(page, "get", "/api/v1/org-structure/change-dates", { status: 200, json: { items: [] } });
  // An opened 업무함 record reads its item's activity; a spec that cares overrides this empty answer.
  await mockRoute(page, "get", "/api/v1/me/action-inbox/items/{id}/activity", { status: 200, json: { items: [] } });
  const consentDoc = { version: "account-test", sha256: "a".repeat(64) };
  await mockRoute(page, "post", "/api/v1/auth/privacy-consent/status", {
    status: 200,
    json: { policy_version: consentDoc.version, accepted: true, accepted_at: AT, privacy: consentDoc, terms: consentDoc },
  });
  await mockRoute(page, "get", "/api/v1/onboarding/terms", {
    status: 200,
    json: {
      ...consentDoc,
      body: "Terms of service",
      privacy: { ...consentDoc, title: "Privacy notice", body: "Privacy notice full text", published_on: AT.slice(0, 10), policy_url: "/privacy", review_pending: false },
    },
  });
  await mockRoute(page, "get", "/api/v1/auth/recovery/status", {
    status: 200,
    json: { eligible: false, is_tenant_ops: false, holder_count: 1, max_holders: 2, contact: null, codes: { total: 10, remaining: 0, generated_at: null } },
  });
  await mockRoute(page, "get", "/api/v1/me/access-log", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/me/profile", {
    status: 200,
    json: {
      employee_id: id(1),
      employee_number: null,
      org_unit: null,
      grade: null,
      position: null,
      hire_date: null,
      employment_status: "ACTIVE",
      phone_masked: null,
      emergency_contacts_registered: false,
      emergency_contacts_count: 0,
      emergency_contacts: [],
      address_masked: null,
      bank_account_registered: false,
      open_change_requests: [],
    },
  });
  await mockRoute(page, "get", "/api/v1/me/certificates", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/me/certificates/{id}", { status: 404, json: failure("not_found") });
  await mockRoute(page, "get", "/api/v1/ref/address-search", { status: 200, json: { status: "OK", items: [], total: 0 } });
  await mockRoute(page, "get", "/api/v2/me/leave", { status: 200, json: { balance: { employee_id: id(1), name: user.display_name, accrued_units: "15", used_units: "5.5", remaining_units: "9.5", filing_state: "ready", home_branch_id: id(4) }, requests: { items: [], next_cursor: null } } });
  await mockRoute(page, "get", "/api/v2/me/leave/team-overlap", { status: 200, json: { org_unit: null, active_count: 0, out_count: 0, members_out: [] } });
  await mockRoute(page, "get", "/api/v2/me/leave/approval-preview", { status: 200, json: { filing_state: "ready", home_branch_id: id(4), branch_name: null, org_unit: null, steps: [] } });
  await mockRoute(page, "get", "/api/v1/me/inbox-docs", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/change-requests", { status: 200, json: { items: [], total: 0, limit: 10, offset: 0 } });
  await mockRoute(page, "get", "/api/v1/change-requests/counts", { status: 200, json: { all: 0, me: 0, role: 0 } });
  await mockRoute(page, "get", "/api/v1/attendance/me/schedule", {
    status: 200,
    json: {
      scope_kind: "WORKPLACE",
      scope_id: id(4),
      scope_name: "HQ",
      month: "2026-11",
      stack: [],
      upcoming: [],
      days: [],
      holidays_loaded: true,
    },
  });
  await mockRoute(page, "get", "/api/v1/attendance/me/exceptions", { status: 200, json: { items: [], total: 0, limit: 50, offset: 0 } });
  await mockRoute(page, "get", "/api/v1/attendance/me/week52", { status: 200, json: { status: "not_available" } });
  await mockRoute(page, "get", "/api/v1/hr/attendance-records/me", { status: 200, json: { items: [], total: 0, limit: 50, offset: 0 } });
  await mockRoute(page, "post", "/api/v1/hr/attendance-records/me", { status: 403, json: failure("attendance.refuse.missing_grant") });
  await mockRoute(page, "get", "/api/v1/attendance/exceptions/{exception_id}", { status: 404, json: failure("not_found") });
  await mockRoute(page, "get", "/api/v2/leave/requests", { status: 200, json: { items: [], next_cursor: null } });
  // Postponing an item and bringing it back answer no body; a spec that cares overrides them.
  await mockRoute(page, "post", "/api/v1/me/action-inbox/items/{id}/snooze", { status: 204 });
  await mockRoute(page, "delete", "/api/v1/me/action-inbox/items/{id}/snooze", { status: 204 });
  await mockDirectorySettings(page);
  await page.route("**/api/v1/me/employee-views", route => route.fulfill({ status: 404, json: failure("not_found") }));
  await mockEventStream(page);
  await page.route("https://status.cosskorea.com/active.json", route =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schema: 1,
        rev: 1,
        generated_at: "2026-11-20T00:00:00Z",
        evidence_at: "2026-11-20T00:00:00Z",
        evidence_expires_at: "2099-01-01T00:00:00Z",
        components: { web: { name: { ko: "Console", en: "Web Console" }, status: "ok", vantage_count: 1 } },
        incidents: [],
      }),
    }),
  );
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const count = state === "empty" ? 0 : state === "large" ? 2000 : 3;
  const rows = employees(count, state === "long");
  const queue = inbox(count, state === "long");
  const tree = structure(count, state === "long");
  // Register hover/focus detail prefetch before facets: Playwright tries later routes first.
  await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 404, json: failure("not_found") });
  await mockRoute(page, "get", "/api/v1/employees/{id}/unit-position", {
    status: 200,
    json: { org_unit_id: null, index: 0, total: 0, prev_id: null, next_id: null, pre_hire_count: 0 },
  });
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
    const ids = query.getAll("ids").flatMap(v => v.split(",")).filter(Boolean);
    if (ids.length > 0) {
      const idSet = new Set(ids);
      const hit = rows.filter(row => idSet.has(row.id));
      return failed ?? { status: 200, json: { items: hit, total: hit.length, offset: 0, limit: hit.length || 100, next_cursor: null } };
    }
    const numbers = query.getAll("employee_number").flatMap(v => v.split(",")).filter(Boolean);
    if (numbers.length > 0) {
      const numSet = new Set(numbers);
      const hit = rows.filter(row => row.employee_number && numSet.has(row.employee_number));
      return failed ?? { status: 200, json: { items: hit, total: hit.length, offset: 0, limit: hit.length || 100, next_cursor: null } };
    }
    const cursor = query.get("cursor");
    const offset = cursor ? rows.findIndex(row => row.id === cursor) + 1 : 0;
    const limit = Number(query.get("limit") ?? 100), end = offset + limit;
    return failed ?? { status: 200, json: { items: rows.slice(offset, end), total: count, offset, limit, next_cursor: end < count ? rows[end - 1]!.id : null } };
  });
  await mockRoute(page, "post", "/api/v1/employees/register-facts/query", async request => {
    const failed = await beforeReply("/api/v1/employees");
    if (failed) return failed;
    const body = request.postDataJSON() as { ids?: string[] } | null;
    const targetIds = body?.ids?.length ? [...body.ids].sort() : rows.map(row => row.id).sort();
    return {
      status: 200,
      json: {
        items: targetIds.map(empId => ({
          employee_id: empId,
          updated_at: "2026-10-26T09:00:00Z",
          sex: "MALE" as const,
          address: "123 Gangnam-daero, Seoul",
          careers: [],
          exit_reason_code: null,
          exit_reason_label: null,
          register_note: null,
          birth_date: "1990-01-01",
        })),
        next_cursor: null,
      },
    };
  });
  await mockRoute(page, "get", "/api/v1/hr/exit-cases/counts", {
    status: 200,
    json: { all: 0, open: 0, closed: 0, reported: 0, hr_confirmed: 0, hq_confirmed: 0, settlement_ready: 0, approval_drafted: 0, submitted: 0, rejected: 0, cancelled: 0 },
  });
  await mockRoute(page, "post", "/api/v1/hr/exit-cases/bulk", request => {
    const body = request.postDataJSON() as { items?: { employee_id: string }[] } | null;
    return { status: 200, json: { results: (body?.items ?? []).map(item => ({ employee_id: item.employee_id, ok: true })) } };
  });
  await mockRoute(page, "get", "/api/v1/appointment-notices/{id}", { status: 404, json: failure("not_found") });
  await mockRoute(page, "get", "/api/v1/appointment-notices/candidates", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/appointment-notices", { status: 200, json: { items: [], next_cursor: null } });
  await mockRoute(page, "get", "/api/v1/hr/certificates/{id}", { status: 404, json: failure("not_found") });
  await mockRoute(page, "get", "/api/v1/hr/certificates/precondition", { status: 200, json: { settings_configured: true, reason_code: null } });
  await mockRoute(page, "get", "/api/v1/hr/certificate-settings", { status: 200, json: { settings: [], seal_max_bytes: 524288, can_manage: false } });
  await mockRoute(page, "get", "/api/v1/hr/certificates", { status: 200, json: { items: [], next_cursor: null } });
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
  const record = orgChange(state === "empty" || state === "held" || state === "unsupported" ? "populated" : state);
  await mockRoute(page, "get", "/api/v1/org-changes/{id}", async () => (await beforeReply("/api/v1/org-changes/{id}")) ?? (state === "missing" ? { status: 404, json: failure("not_found") } : { status: 200, json: record }));
  await mockRoute(page, "post", "/api/v1/org-changes/{id}/preflight", { status: 200, json: record });
  await mockLifecycleSheets(page, screen);
  const counts = await mockOrgChangeCounts(page, screen.key === "org-changes" && (state === "loading" || state === "failed") ? state : "populated", changes);
  await mockPayroll(page, screen, state, held);
  const boardScreen = attendanceBoardScreens.find(candidate => candidate.key === screen.key);
  const board = boardScreen ? await attendanceBoardReads(page, boardScreen, state as "populated" | "empty" | "failed" | "refused" | "loading") : null;
  return { unexpected, release: () => { release(); counts.release(); board?.release(); }, count, operationId: id(99), ...(screen.key === "numbering" ? await numberingReads(page, "operating") : {}) };
}
