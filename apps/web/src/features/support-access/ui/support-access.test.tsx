// SPDX-License-Identifier: LicenseRef-Proprietary
import { EnumValue } from "../../../ui/enum-value";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../../reference/support-access/api";
import { readIdentity } from "../../../lib/query";
import { ActiveSupportBanner, SupportAccess, SupportAccessIndicator } from "./support-access";
import { activeSupportQuery, supportSessionsQuery, supportRefusal, type SupportSession } from "../../../reference/support-access/api";

const state = vi.hoisted(() => ({
  data: undefined as unknown, active: undefined as unknown, error: undefined as unknown,
  pending: false, calls: [] as { run: (input: unknown, key: string) => Promise<unknown> }[],
  get: vi.fn(), post: vi.fn(), query: vi.fn(), auth: { token: null as string | null },
}));
vi.mock("@console/api", async (original) => ({ ...await original<object>(), api: { GET: state.get, POST: state.post }, session: state.auth }));
vi.mock("@console/i18n", async (original) => ({ ...await original<object>(), t: (key: string) => key, isMessageId: () => true }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => ({ review: undefined }), useNavigate: () => vi.fn() }), Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-to={to}>{children}</span> }));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<object>(), useQuery: (q: Parameters<typeof readIdentity>[0]) => { state.query(q); return {
  data: readIdentity(q) === readIdentity(activeSupportQuery) ? state.active : readIdentity(q) === readIdentity(supportSessionsQuery) ? state.data : undefined,
  error: state.error, isError: !!state.error, isPending: state.pending, refetch: vi.fn(),
}; } }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (opts: typeof state.calls[number]) => {
  state.calls.push(opts);
  return { mutate: vi.fn(), isPending: false, error: undefined };
}, outcomeUnknown: () => false, recoveryOf: () => undefined }));

const session: SupportSession = {
  id: "session-a", operator_label: "공급사 · 운영자 A", ticket_ref: "HELP-123", reason_code: "DIAGNOSE", reason: "조회 화면 오류 확인",
  scope: ["hr_basic"], state: "OPERATOR_APPROVED", masked: true, requested_duration_seconds: 1800,
  approved_duration_seconds: null, tenant_approved_at:null,requested_at: "2026-10-23T00:00:00Z", request_expires_at: "2026-10-23T12:00:00Z", expires_at: null,
  decisions: [{ actor_label: "운영자 B", decision: "OPERATOR_APPROVE", at: "2026-10-23T00:01:00Z" }],
  records: [{ id: "record-a", method: "GET", path: "/api/v1/employees", at: "2026-10-23T00:03:00Z" }],
};
beforeEach(() => {
  state.data = { sessions: [session], can_approve: true };
  state.active = { sessions: [], can_approve: true, pending_count: 0, pending_approvals: [] };
  state.error = undefined; state.pending = false; state.calls = [];
  state.get.mockReset(); state.post.mockReset(); state.query.mockReset();
  state.auth.token = null;
  state.post.mockResolvedValue({ data: {}, response: new Response(null, { status: 200 }) });
});

test("support reads wait for a session token", () => {
  renderToStaticMarkup(<><ActiveSupportBanner /><SupportAccessIndicator /><SupportAccess /></>);
  expect(state.query.mock.calls.map(([q]) => q.enabled)).toEqual([false, false, false]);
  state.auth.token = "session-token";
  state.query.mockClear();
  renderToStaticMarkup(<><ActiveSupportBanner /><SupportAccessIndicator /><SupportAccess /></>);
  expect(state.query.mock.calls.map(([q]) => q.enabled)).toEqual([true, true, true]);
});

const refusals = [
  "step_up_required", "requester_cannot_approve", "no_second_operator", "not_tenant_approved", "request_expired",
  "session_ended", "session_expired", "read_only", "out_of_scope", "reveal_not_granted", "no_tenant_approver",
];
test.each(refusals)("support refusal %s has an actionable UI message", (code) => {
  const full = `support.refuse.${code}`;
  expect(supportRefusal(full)).toBe(full);
  state.data = undefined;
  state.error = new ApiError(code.startsWith("session_") ? 401 : 403, full, "", []);
  expect(renderToStaticMarkup(<SupportAccess />)).toContain(full);
});
test("wrong-realm 401 has support-specific copy; unknown errors keep the shared fallback", () => {
  expect(supportRefusal("unauthorized")).toBe("supportAccess.wrongRealm");
  expect(supportRefusal("unrecognized")).toBeUndefined();
});
test("the tenant sees purpose, scope, bounded duration, decisions and access records", () => {
  const html = renderToStaticMarkup(<SupportAccess />);
  for (const text of ["HELP-123", session.reason, session.operator_label, "supportAccess.duration", "supportAccess.masked", "supportAccess.approve", "supportAccess.deny", "운영자 B", "/api/v1/employees"]) expect(html).toContain(text);
  expect(html).toContain("max=\"30\"");
  expect(html).toContain("supportAccess.revealPersonal");
});
test("approval and end commands use the shared authenticated API and retain their intent key", async () => {
  renderToStaticMarkup(<SupportAccess />);
  await state.calls[0]!.run({ decision: "APPROVE", approved_duration_seconds: 900, reveal_classes: [] }, "intent-a");
  expect(state.post).toHaveBeenCalledWith("/api/v1/support-sessions/{id}/decision", { params:{path:{id:"session-a"}},body: { decision: "APPROVE", approved_duration_seconds: 900, reveal_classes: [] }, headers: { "Idempotency-Key": "intent-a" } });
  await state.calls[1]!.run(undefined, "intent-b");
  expect(state.post).toHaveBeenLastCalledWith("/api/v1/support-sessions/{id}/end", { params:{path:{id:"session-a"}},headers: { "Idempotency-Key": "intent-b" } });
});
test("the banner names an active operator and expiry on any tenant page", () => {
  expect(renderToStaticMarkup(<ActiveSupportBanner />)).toBe("");
  state.active = { sessions: [{ id: session.id, operator_label: session.operator_label, expires_at: "2026-10-23T00:30:00Z" }], can_approve: false };
  const html = renderToStaticMarkup(<ActiveSupportBanner />);
  expect(html).toContain(session.operator_label);
  expect(html).toContain("supportAccess.bannerExpiry");
  expect(html).not.toContain("supportAccess.bannerAction");
});
test("loading, empty and failed active-session reads remain honest", () => {
  state.pending = true;
  expect(renderToStaticMarkup(<SupportAccess />)).toContain("common.loading");
  state.pending = false; state.data = { sessions: [], can_approve: true };
  expect(renderToStaticMarkup(<SupportAccess />)).toContain("supportAccess.emptyTitle");
  state.error = new ApiError(503, "unavailable", "", []); state.active = undefined;
  expect(renderToStaticMarkup(<ActiveSupportBanner />)).toContain("common.retry");
});

test("a support read failure retains the active notice until the server refuses it", () => {
  state.active = { sessions: [session], can_approve: false };
  state.error = new ApiError(503, "unavailable", "raw upstream detail", []);
  const stale = renderToStaticMarkup(<ActiveSupportBanner />);
  expect(stale).toContain(session.operator_label);
  expect(stale).toContain("common.read.stale");
  expect(stale).toContain("common.retry");
  state.error = new ApiError(403, "forbidden", "raw upstream detail", []);
  const denied = renderToStaticMarkup(<ActiveSupportBanner />);
  expect(denied).toContain("common.denied.title.plain");
  expect(denied).not.toContain(session.operator_label);
});

test("the tenant can withdraw approval before the operator starts", () => {
  state.data = { sessions: [{ ...session, tenant_approved_at: "2026-10-23T00:02:00Z" }], can_approve: true };
  const html = renderToStaticMarkup(<SupportAccess />);
  expect(html).toContain("supportAccess.end");
  expect(html).not.toContain(">supportAccess.approve</button>");
});

test("non-approvers have no approval, denial, or termination controls", () => {
  state.data = { sessions: [session], can_approve: false };
  const html = renderToStaticMarkup(<SupportAccess />);
  for (const control of ["supportAccess.approve", "supportAccess.deny", "supportAccess.end"])
    expect(html).not.toContain(`>${control}</button>`);
});
test("the live notification deep-links to the pending request for approvers only", () => {
  state.active = { sessions: [], can_approve: true, pending_count: 1, pending_approvals: [session] };
  expect(renderToStaticMarkup(<ActiveSupportBanner />)).toContain("supportAccess.pending");
  state.active = { sessions: [], can_approve: false, pending_count: 1, pending_approvals: [session] };
  expect(renderToStaticMarkup(<ActiveSupportBanner />)).not.toContain("supportAccess.pending");
});

test("the compact indicator follows pending and active support without exposing approval links to readers", () => {
  expect(renderToStaticMarkup(<SupportAccessIndicator />)).toBe("");
  state.active = { sessions: [], can_approve: true, pending_count: 1, pending_approvals: [session] };
  expect(renderToStaticMarkup(<SupportAccessIndicator />)).toContain('data-to="/audit/support-access"');
  state.active = { sessions: [], can_approve: false, pending_count: 1, pending_approvals: [] };
  expect(renderToStaticMarkup(<SupportAccessIndicator />)).toBe("");
  state.active = { sessions: [session], can_approve: false, pending_count: 0, pending_approvals: [] };
  const html = renderToStaticMarkup(<SupportAccessIndicator />);
  expect(html).toContain('role="status"');
  expect(html).toContain("supportAccess.indicator");
  expect(html).not.toContain("data-to");
  state.error = new ApiError(503, "unavailable", "", []);
  expect(renderToStaticMarkup(<SupportAccessIndicator />)).toBe("");
});

test("loading and pending requests for another approver leave no empty banner", () => {
  state.active = undefined;
  expect(renderToStaticMarkup(<ActiveSupportBanner />)).toBe("");
  state.active = { sessions: [], can_approve: false, pending_count: 1, pending_approvals: [] };
  expect(renderToStaticMarkup(<ActiveSupportBanner />)).toBe("");
});

test("active details show the support deadline without an approval form or pending deadline", () => {
  state.data = { sessions: [{ ...session, state: "ACTIVE", approved_duration_seconds: 1800 }], can_approve: true };
  const html = renderToStaticMarkup(<SupportAccess />);
  expect(html).toContain("supportAccess.expiresAt");
  expect(html).not.toContain("supportAccess.requestExpiresAt");
  expect(html).not.toContain("supportAccess.durationMinutes");
});

test("a revoked approver cannot retain cached support details or controls after a 403", () => {
  state.error = new ApiError(403, "forbidden", "", []);
  const html = renderToStaticMarkup(<SupportAccess />);
  expect(html).not.toContain(session.operator_label);
  expect(html).not.toContain(">supportAccess.approve</button>");
  expect(html).not.toContain(">supportAccess.deny</button>");
});

vi.mock("../../../ui/enum-value", async original => {
  const actual = await original<typeof import("../../../ui/enum-value")>();
  return { ...actual, EnumValue: vi.fn(actual.EnumValue) };
});

test.each(["REQUESTED", "OPERATOR_APPROVED", "ACTIVE", "ENDED", "EXPIRED", "DENIED", "REVOKED"])("support session %s renders through EnumValue", value => {
  state.data = { sessions: [{ ...session, state: value }], can_approve: false };
  vi.mocked(EnumValue).mockClear();
  const out = renderToStaticMarkup(<SupportAccess />);
  expect(vi.mocked(EnumValue).mock.calls.map(([p]) => [p.e.type, p.value])).toEqual([["supportSessionState", value]]);
  expect(out).toContain(`<span class="chip chip--${value === "ACTIVE" ? "warn" : "neutral"}">supportAccess.state.${value}</span>`);
});
