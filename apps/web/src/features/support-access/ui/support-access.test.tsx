// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../api";
import { ActiveSupportBanner, SupportAccess } from "./support-access";
import { activeSupportQuery, supportSessionsQuery, pendingApprovalQuery, supportRefusal, type SupportSession } from "../api";

const state = vi.hoisted(() => ({
  data: undefined as unknown, active: undefined as unknown, error: undefined as unknown,
  pending: false, calls: [] as { run: (input: unknown, key: string) => Promise<unknown> }[],
  get: vi.fn(), post: vi.fn(),
}));
vi.mock("@console/api", async (original) => ({ ...await original<object>(), api: { GET: state.get, POST: state.post } }));
vi.mock("@console/i18n", async (original) => ({ ...await original<object>(), t: (key: string) => key, isMessageId: () => true }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-to={to}>{children}</span> }));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<object>(), useQuery: (q: unknown) => ({
  data: q === activeSupportQuery ? state.active : state.data,
  error: state.error, isError: !!state.error, isPending: state.pending, refetch: vi.fn(),
}) }));
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
  state.active = { sessions: [], can_approve: true };
  state.error = undefined; state.pending = false; state.calls = [];
  state.get.mockReset(); state.post.mockReset();
  state.post.mockResolvedValue({ data: {}, response: new Response(null, { status: 200 }) });
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
test("the G2 source contains only requests the tenant can approve", () => {
  const select = pendingApprovalQuery.select;
  expect(select({ sessions: [session, { ...session, id: "active", state: "ACTIVE" }], can_approve: true })).toEqual([session]);
  expect(select({ sessions: [session], can_approve: false })).toEqual([]);
  expect(pendingApprovalQuery).toMatchObject(supportSessionsQuery);
});
test("the tenant sees purpose, scope, bounded duration, decisions and access records", () => {
  const html = renderToStaticMarkup(<SupportAccess />);
  for (const text of ["HELP-123", session.reason, session.operator_label, "1800", "supportAccess.masked", "supportAccess.approve", "supportAccess.deny", "운영자 B", "/api/v1/employees"]) expect(html).toContain(text);
  expect(html).toContain("max=\"1800\"");
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
  expect(html).toContain("/audit/support-access");
});
test("loading, empty and failed active-session reads remain honest", () => {
  state.pending = true;
  expect(renderToStaticMarkup(<SupportAccess />)).toContain("common.loading");
  state.pending = false; state.data = { sessions: [], can_approve: true };
  expect(renderToStaticMarkup(<SupportAccess />)).toContain("supportAccess.emptyTitle");
  state.error = new ApiError(503, "unavailable", "", []); state.active = undefined;
  expect(renderToStaticMarkup(<ActiveSupportBanner />)).toContain("common.retry");
});
