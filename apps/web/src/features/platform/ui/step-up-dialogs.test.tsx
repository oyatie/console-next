// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { ApiError, type Group, type OperatorSummary, type Org, type SupportSessionMetadata } from "../api";
import { DomainDialog } from "./domain-dialog";
import { AssignOrgDialog, CreateGroupAccountDialog } from "./group-dialogs";
import { InviteOperatorDialog, OperatorConsolePanel } from "./operator-console-panel";
import { OpsRecovery } from "./ops-recovery";
import { OpsRecoveryOpenSheet } from "./ops-recovery-open-sheet";
import { SupportSessionPanel } from "./support-console-panel";
import { RequestSupportDialog } from "./support-request-dialog";
import { TenantConsolePanel } from "./tenant-console-panel";
import { EraseControls } from "./tenant-erase";

const state = vi.hoisted(() => ({
  error: undefined as unknown,
  recoveryData: {
    state: null,
    recovery_available: true,
    ops_has_passkey: true,
    ops_enrolled: true,
    second_operator_available: true,
    active_accounts: 2,
    hold_hours: 24,
    code_ttl_minutes: 15,
    request: null,
  },
  eraseData: { archived: false, legal_hold: false, second_operator_available: true, cooling_hours: 72, request: null },
}));

vi.mock("../../../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
}));
vi.mock("../../../lib/react/command", async (original) => ({
  ...(await original<typeof import("../../../lib/react/command")>()),
  useCommand: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: state.error }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (q: Record<string, unknown>) => {
    const key = JSON.stringify(q);
    if (key.includes("ops-recovery")) return { isSuccess: true, isPending: false, isFetching: false, isError: false, data: state.recoveryData, refetch: vi.fn() };
    if (key.includes("erase")) return { isSuccess: true, isPending: false, isFetching: false, isError: false, data: state.eraseData };
    if (key.includes("support-sessions")) return { isSuccess: true, isPending: false, isFetching: false, isError: false, data: { sessions: [] } };
    if (key.includes("company-domain")) return { isSuccess: true, isPending: false, isFetching: false, isError: false, data: { available: true, alias_days: 30 } };
    return { isSuccess: true, isPending: false, isFetching: false, isError: false, data: undefined };
  },
}));

beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]));
afterEach(() => {
  state.error = undefined;
});

const render = (node: ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

const org: Org = {
  id: "org-1",
  name: "Alpha Co",
  slug: "alpha",
  status: "ACTIVE",
  lifecycle: "OPERATING",
  group_id: null,
  group_slug: null,
  group_name: null,
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
};

const group: Group = {
  id: "grp-1",
  slug: "alpha-grp",
  name: "Alpha Group",
  status: "ACTIVE",
  member_count: 1,
  members: [{ id: "org-1", slug: "alpha", name: "Alpha Co", status: "ACTIVE" }],
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
};

const peerOp: OperatorSummary = {
  user_id: "op-2",
  display_name: "Minho Kang",
  sign_in_id: "minho@platform",
  is_active: true,
  has_passkey: true,
  device_bound_passkey: true,
  status: "ACTIVE",
  invited_by: "op-1",
  invite_expires_at: null,
  created_at: "2026-10-25T00:00:00Z",
};

const pendingOp: OperatorSummary = {
  ...peerOp,
  user_id: "op-3",
  has_passkey: false,
  device_bound_passkey: false,
  status: "PENDING_ENROLMENT",
  invite_expires_at: "2026-12-30T00:00:00Z",
};

const session: SupportSessionMetadata = {
  id: "sess-1",
  org_id: "org-1",
  operator_ref: "op-1",
  operator_approver_ref: null,
  state: "REQUESTED",
  requested_at: "2026-10-25T00:00:00Z",
  expires_at: null,
  request_expires_at: "2026-10-25T01:00:00Z",
  requested_duration_seconds: 3600,
  scope: ["org"],
  tenant_approved: false,
};

const noop = () => undefined;

test("step-up UIs suppress passkey_cancelled without alert or networkError", () => {
  i18n.set("ko");
  state.error = new Error("passkey_cancelled");
  const surfaces = [
    render(<AssignOrgDialog open group={group} orgs={[org]} onClose={noop} onDone={noop} />),
    render(<CreateGroupAccountDialog open group={group} onClose={noop} onCreated={noop} />),
    render(<OperatorConsolePanel op={pendingOp} all={[peerOp, pendingOp]} currentUserId="op-1" onIssued={noop} onRevoked={noop} />),
    render(<InviteOperatorDialog open onClose={noop} onInvited={noop} />),
    render(<SupportSessionPanel session={session} currentOperatorId="op-2" onApproved={noop} onStarted={noop} onEnded={noop} />),
    render(<RequestSupportDialog open orgs={[org]} initialOrg={org} onClose={noop} onRequested={noop} />),
    render(<DomainDialog org={org} onClose={noop} onDone={noop} />),
    render(<OpsRecovery org={org} data={state.recoveryData} onIssued={noop} />),
    render(<OpsRecoveryOpenSheet org={org} data={state.recoveryData} onClose={noop} />),
    render(<EraseControls org={org} data={state.eraseData} />),
  ];
  for (const html of surfaces) {
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(t("common.networkError"));
  }
});

test("step-up UIs show auth.passkey.unavailable and localized supportRefusal via PasskeyError", () => {
  i18n.set("ko");
  state.error = new Error("passkey_unavailable");
  for (const html of [
    render(<InviteOperatorDialog open onClose={noop} onInvited={noop} />),
    render(<DomainDialog org={org} onClose={noop} onDone={noop} />),
    render(<OpsRecovery org={org} data={state.recoveryData} onIssued={noop} />),
    render(<OpsRecoveryOpenSheet org={org} data={state.recoveryData} onClose={noop} />),
    render(<EraseControls org={org} data={state.eraseData} />),
  ]) {
    expect(html).toContain(t("auth.passkey.unavailable"));
  }

  state.error = new ApiError(403, "support.refuse.requester_cannot_approve", "raw");
  const refusalHtml = render(
    <SupportSessionPanel session={session} currentOperatorId="op-2" onApproved={noop} onStarted={noop} onEnded={noop} />,
  );
  expect(refusalHtml).toContain(t("support.refuse.requester_cannot_approve"));
});

test("OperatorConsolePanel uses secondary revoke trigger and TenantConsolePanel flattens Reissue/OpsRecovery", () => {
  i18n.set("ko");
  const opHtml = render(
    <OperatorConsolePanel op={peerOp} all={[peerOp, pendingOp]} currentUserId="op-1" onIssued={noop} onRevoked={noop} />,
  );
  expect(opHtml).toContain(t("tenants.operators.revoke"));
  expect(opHtml).not.toContain("btn--danger");

  const tenantHtml = render(
    <TenantConsolePanel
      org={org}
      health={{
        id: org.id,
        slug: org.slug,
        name: org.name,
        status: "ACTIVE",
        group_id: null,
        group_slug: null,
        group_name: null,
        user_count: 10,
        active_user_count: 10,
        active_work_orders: 1,
        open_work_orders: 1,
        zero_legacy_release_cycles: 2,
        route_adoption: [],
        last_activity_at: "2026-10-25T00:00:00Z",
      }}
      onIssued={noop}
      onRecorded={noop}
      onRemoved={noop}
      onOpenSupport={noop}
    />,
  );
  expect(tenantHtml).toContain(t("tenants.section.code"));
  expect(tenantHtml).toContain(t("opsRecovery.title"));
  expect(tenantHtml).toContain(t("tenants.panel.healthWorkOrders"));
  expect(tenantHtml).toContain(t("tenants.status.suspend", { org: org.name }));
  expect(tenantHtml).toContain(t("tenants.remove.force", { org: org.name }));
  expect(tenantHtml).not.toContain(`>${t("tenants.col.status")}<`);
  expect(tenantHtml).not.toContain('id="tenant-code"');
  expect(tenantHtml).not.toContain('id="tenant-ops-recovery"');
  // The pane draws the headings, and each section Classic makes a region stays one region, named once.
  const headings = new Map([...tenantHtml.matchAll(/<h3[^>]*id="([^"]*)"[^>]*>([^<]*)<\/h3>/g)].map(m => [m[1], m[2]]));
  const regions = [...tenantHtml.matchAll(/<section[^>]*aria-labelledby="([^"]*)"/g)].map(m => headings.get(m[1]!));
  expect(regions.filter(name => name === t("tenants.section.code"))).toHaveLength(1);
  expect(regions.filter(name => name === t("opsRecovery.title"))).toHaveLength(1);
});

test("ops recovery inside the Console record pane stays a single region named by RecordPaneSection", () => {
  i18n.set("ko");
  state.error = undefined;
  const html = render(<OpsRecovery embedded org={org} data={state.recoveryData} onIssued={noop} />);
  // RecordPaneSection owns the <section aria-labelledby> region above embedded OpsRecovery so regions never nest.
  expect(html.startsWith("<div")).toBe(true);
  expect(html).not.toContain("<section");
});
