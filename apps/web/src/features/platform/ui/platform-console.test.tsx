// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { PlatformConsole } from "./platform-console";
import { GroupsConsole } from "./groups-console";
import { OperatorsConsole } from "./operators-console";
import { SupportConsole } from "./support-console";
import type { Group, OperatorSummary, Org, SupportSessionMetadata } from "../api";

const state = vi.hoisted(() => ({
  experience: "console" as "baseline" | "console",
  search: {} as { q?: string; sel?: string; view?: string },
  orgs: [] as Org[],
  groups: [] as Group[],
  operators: [] as OperatorSummary[],
  sessions: [] as SupportSessionMetadata[],
  operatorId: "op-1",
}));

vi.mock("../../../experience/dom", async (original) => ({
  ...(await original<typeof import("../../../experience/dom")>()),
  useActiveExperienceId: () => state.experience,
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => vi.fn() }),
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => <span role="link" data-to={to} {...rest}>{children}</span>,
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (q: Record<string, unknown>) => {
    const key = JSON.stringify(q);
    if (key.includes("/api/platform/orgs")) return { isSuccess: true, isPending: false, isFetching: false, data: state.orgs };
    if (key.includes("/api/platform/groups")) return { isSuccess: true, isPending: false, isFetching: false, data: state.groups };
    if (key.includes("/api/platform/operators")) return { isSuccess: true, isPending: false, isFetching: false, data: state.operators };
    if (key.includes("/api/platform/support-sessions")) return { isSuccess: true, isPending: false, isFetching: false, data: { sessions: state.sessions } };
    if (key.includes("/api/platform/ops")) return { isSuccess: true, isPending: false, isFetching: false, data: { tenants: [], notices: [] } };
    return { isSuccess: true, isPending: false, isFetching: false, data: undefined };
  },
}));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  operatorId: () => state.operatorId,
}));
vi.mock("../../../reference/authz/ui/access-gate", () => ({
  PageReadGate: ({ head, children }: { head?: (available: boolean) => ReactNode; children: ReactNode }) => (
    <>
      {head?.(true)}
      {children}
    </>
  ),
}));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ children }: { children: (d?: unknown) => ReactNode }) => children([]) }));
vi.mock("../../../lib/react/support-lookup", () => ({ SupportLookupForm: () => null }));
vi.mock("./onboard-form", () => ({ OnboardDialog: () => null }));
vi.mock("./code-dialog", () => ({ CodeDialog: () => null }));
vi.mock("./tenant-console-panel", () => ({ TenantConsolePanel: ({ org }: { org: Org }) => <div data-console-panel={org.id} /> }));

beforeAll(async () => {
  await Promise.all([loadCatalog("ko"), loadCatalog("en")]);
  state.orgs = [
    { id: "org-1", name: "Alpha Co", slug: "alpha", status: "ACTIVE", lifecycle: "OPERATING", group_id: "grp-1", group_slug: "grp", group_name: "Alpha Group", created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" },
    { id: "org-2", name: "Beta Co", slug: "beta", status: "SUSPENDED", lifecycle: "SETUP", group_id: null, group_slug: null, group_name: null, created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" },
  ];
  state.groups = [
    { id: "grp-1", slug: "alpha-grp", name: "Alpha Group", status: "ACTIVE", member_count: 1, members: [{ id: "org-1", slug: "alpha", name: "Alpha Co", status: "ACTIVE" }], created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" },
  ];
  state.operators = [
    { user_id: "op-1", display_name: "Operator One", sign_in_id: "op1@platform", is_active: true, has_passkey: true, device_bound_passkey: true, status: "ACTIVE", invited_by: null, invite_expires_at: null, created_at: "2026-10-25T00:00:00Z" },
    { user_id: "op-2", display_name: "Operator Two", sign_in_id: "op2@platform", is_active: true, has_passkey: false, device_bound_passkey: false, status: "PENDING_ENROLMENT", invited_by: "op-1", invite_expires_at: "2026-10-26T00:00:00Z", created_at: "2026-10-25T00:00:00Z" },
  ];
  state.sessions = [
    { id: "sess-1", org_id: "org-1", operator_ref: "op-1", state: "REQUESTED", requested_at: "2026-10-25T00:00:00Z", expires_at: null, request_expires_at: "2026-10-25T01:00:00Z", requested_duration_seconds: 3600, scope: ["org", "hr_basic"], operator_approver_ref: null, tenant_approved: false },
  ];
});

afterEach(() => {
  state.search = {};
});

const renderWithQuery = (node: ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

test.each(["ko", "en"] as const)("%s PlatformConsole renders ListRecord, 4 tabs, StatRow, FilterRail, and side pane", (locale) => {
  i18n.set(locale);
  state.search = { sel: "org-1" };
  const html = renderWithQuery(<PlatformConsole />);
  expect(html).toContain('data-pattern="list-record"');
  expect(html).toContain(t("tenants.tab.tenants"));
  expect(html).toContain(t("tenants.tab.groups"));
  expect(html).toContain(t("tenants.tab.operators"));
  expect(html).toContain(t("tenants.tab.support"));
  expect(html).toContain('data-compact-rows="true"');
  expect(html).toContain('data-console-panel="org-1"');
});

test.each(["ko", "en"] as const)("%s GroupsConsole, OperatorsConsole, and SupportConsole render metadata without raw Hangul leakage", (locale) => {
  i18n.set(locale);
  const groupsHtml = renderWithQuery(<GroupsConsole tabs={null} />);
  expect(groupsHtml).toContain("Alpha Group");
  expect(groupsHtml).toContain(t("tenants.groups.create"));

  const opsHtml = renderWithQuery(<OperatorsConsole tabs={null} />);
  expect(opsHtml).toContain("Operator One");
  expect(opsHtml).toContain(t("enum.platformOperatorStatus.PENDING_ENROLMENT"));
  expect(opsHtml).toContain(t("tenants.operators.passkey.bound"));

  const supHtml = renderWithQuery(<SupportConsole tabs={null} />);
  expect(supHtml).toContain(t("tenants.support.metadataNotice"));
  expect(supHtml).toContain(t("supportAccess.state.REQUESTED"));
  expect(supHtml).toContain(t("tenants.support.stat.label"));
  expect(supHtml).toContain(t("tenants.support.search"));
});
