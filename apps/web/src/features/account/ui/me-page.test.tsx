// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import { PagePhoneHeader } from "../../../ui/page/page-scope";
import {
  consentDocumentsQuery,
  consentQuery,
  meProfileQuery,
  meQuery,
  myAccessLogQuery,
  myChangeRequestsQuery,
  myLeaveSummaryQuery,
  myPayslipDocsQuery,
  operatorMeQuery,
  passkeysQuery,
  tenantRecoveryQuery,
  ApiError,
} from "../api";
import { myAccessQuery } from "../../../reference/authz/api";
import { MePage } from "./me-page";
import { MyAccessCard } from "./my-access";

const state = vi.hoisted(() => ({
  experience: "console" as "baseline" | "console",
  search: {} as Record<string, unknown>,
  platform: false,
  me: {
    id: "u1",
    display_name: "Hajun Yun",
    sign_in_id: "hajun@saeon",
    employee_id: "e1",
    employee_name: "Hajun Yun",
    employee_number: "10587",
    employee_company: "Saeon Precision",
    employee_org_unit: "Prod Team 1",
    employee_position: "Lead",
    employee_grade: "Senior Staff",
    employee_hire_date: "2019-03-14",
    employee_employment_status: "ACTIVE",
    employee_link_status: "LINKED" as "LINKED" | "UNLINKED",
    phone: "010-1234-4821",
    is_tenant_ops: false,
    has_passkey: true,
    account_status: "ACTIVE",
    tenant: { name: "Saeon Group", phase: "OPERATING", go_live_at: "2026-01-01T00:00:00Z" },
  },
  profileError: null as unknown,
  profile: {
    employee_id: "e1",
    employee_number: "10587",
    org_unit: "Prod Team 1",
    grade: "Senior Staff",
    position: "Lead",
    hire_date: "2019-03-14",
    employment_status: "ACTIVE",
    phone_masked: "010-••••-4821",
    emergency_contacts_registered: true,
    emergency_contacts_count: 1,
    emergency_contacts: [{ name: "Seoyeong", relation: "SPOUSE", phone_masked: "010-••••-9012" }],
    address_masked: "Gyeonggi Pyeongtaek Godeok-dong",
    bank_account_registered: true,
    open_change_requests: [
      { id: "cr1", field: "address", status: "OPEN", masked_summary: "Gyeonggi Pyeongtaek Godeok-dong", created_at: "2026-11-02T02:00:00Z" },
    ],
  },
  accessLogItems: [
    {
      event_id: "ev1",
      occurred_at: "2026-11-03T02:00:00Z",
      actor_name: "Seoyeon Moon",
      actor_team: "HR Team",
      action: "employee.rrn_reveal",
      field: "RRN",
      reason_code: "SOCIAL_INSURANCE_FILING",
      target_type: "employee",
    },
  ],
  changeRequestItems: [
    {
      id: "cr1",
      kind: "PROFILE_CORRECTION",
      subject_type: "EMPLOYEE",
      subject_id: "e1",
      payload: { changes: { address: "Godeok-dong, Pyeongtaek" } },
      reason_code: "OTHER",
      requested_by: "u1",
      assignee_role: "HR",
      status: "OPEN",
      review_required: false,
      created_at: "2026-11-02T02:00:00Z",
    },
  ],
}));

vi.mock("../../../experience/dom", () => ({
  useActiveExperienceId: () => state.experience,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => "/account",
  useRouter: () => ({ history: { back: vi.fn() } }),
  useSearch: ({ select }: { select: (search: Record<string, unknown>) => unknown }) => select(state.search),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <div data-href={to}>{children}</div>,
}));

vi.mock("./me-certificates-sheet", () => ({
  MeCertificatesSheet: ({ open }: { open: boolean }) => <div data-certificates-sheet={open ? "open" : "closed"} />,
}));

vi.mock("../api", async original => {
  const actual = await original<typeof import("../api")>();
  return {
    ...actual,
    claims: () => ({ name: state.me.display_name, platform: state.platform, org: "org-1" }),
  };
});

vi.mock("@tanstack/react-query", async original => {
  const actual = await original<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (q: { queryFn?: unknown }) => {
      if (q === passkeysQuery || q?.queryFn === passkeysQuery.queryFn) {
        return { data: [{ id: "k1", label: "Passkey A", created_at: "2026-10-25T00:00:00Z", last_used_at: null }], isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === meQuery || q === operatorMeQuery || q?.queryFn === meQuery.queryFn || q?.queryFn === operatorMeQuery.queryFn) {
        return { data: state.me, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === meProfileQuery || q?.queryFn === meProfileQuery.queryFn) {
        if (state.profileError) {
          return { data: undefined, isPending: false, isSuccess: false, isError: true, error: state.profileError, refetch: vi.fn() };
        }
        return { data: state.profile, isPending: false, isSuccess: true, isError: false, error: null, refetch: vi.fn() };
      }
      if (q === myAccessLogQuery || q?.queryFn === myAccessLogQuery.queryFn) {
        return { data: { items: state.accessLogItems, next_cursor: null }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === myLeaveSummaryQuery || q?.queryFn === myLeaveSummaryQuery.queryFn) {
        return { data: { balance: { remaining_units: "9.5" }, requests: { items: [], next_cursor: null } }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === myPayslipDocsQuery || q?.queryFn === myPayslipDocsQuery.queryFn) {
        return { data: { items: [{ id: "doc1", kind: "payslip", title: "Payslip 2026-10-01 ~ 2026-10-31", locked: false, created_at: "2026-11-10T00:00:00Z" }], next_cursor: null }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === myChangeRequestsQuery || q?.queryFn === myChangeRequestsQuery.queryFn) {
        return { data: { items: state.changeRequestItems, total: state.changeRequestItems.length, limit: 10, offset: 0 }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === myAccessQuery || q?.queryFn === myAccessQuery.queryFn) {
        return { data: { is_ops: false, entries: [] }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === consentQuery || q?.queryFn === consentQuery.queryFn) {
        return { data: { accepted: true, accepted_at: "2026-10-25T00:00:00Z" }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === consentDocumentsQuery || q?.queryFn === consentDocumentsQuery.queryFn) {
        return { data: { privacy: { title: "Privacy Notice", published_on: "2026-10-20", body: "Notice body", policy_url: "/privacy" } }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      if (q === tenantRecoveryQuery || q?.queryFn === tenantRecoveryQuery.queryFn) {
        return { data: { request: null, state: null }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
      }
      return { data: undefined, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
    },
  };
});

beforeAll(() => loadCatalog("ko"));
afterEach(() => {
  state.experience = "console";
  state.platform = false;
  state.search = {};
  state.me.employee_link_status = "LINKED";
  state.profileError = null;
});

function renderMe(shellOwnsH1 = false) {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PagePhoneHeader value={{ shellOwnsH1 }}>
        <MePage locale={<div id="acct-locale" />} experience={<div id="account-experience" />} singleKeys={<div id="acct-keys" />} />
      </PagePhoneHeader>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

test("MePage keeps baseline Card rendering unaltered and switches to PhoneHub in Console mode", () => {
  state.experience = "baseline";
  const baselineHtml = renderMe(false);
  expect(baselineHtml).not.toContain('data-pattern="phone-hub"');
  expect(baselineHtml).toContain(`>${t("account.title")}</h1>`);

  state.experience = "console";
  const consoleDesktop = renderMe(false);
  expect(consoleDesktop).toContain('data-pattern="phone-hub"');
  expect(consoleDesktop).toContain(`>${t("shell.profile")}</h1>`);
  expect(consoleDesktop).toContain("Hajun Yun");
  expect(consoleDesktop).toContain(t("enum.employeeStatus.ACTIVE"));
  expect(consoleDesktop).toContain("Senior Staff · Lead");
  expect(consoleDesktop).toContain("10587");
  expect(consoleDesktop).toContain("Prod Team 1");
  expect(consoleDesktop).toContain("2019-03-14");
  expect(consoleDesktop).toContain(t("account.hub.certificates"));
  expect(consoleDesktop).toContain(t("account.hub.leaveRemaining", { days: 9.5 }));
  expect(consoleDesktop).toContain(fmtMonth("2026-10"));
  expect(consoleDesktop).toContain("010-••••-4821");
  expect(consoleDesktop).toContain(t("account.selfEdit.emergency"));
  expect(consoleDesktop).toContain(t("account.selfEdit.address"));
  expect(consoleDesktop).toContain("Gyeonggi Pyeongtaek Godeok-dong");
  expect(consoleDesktop).toContain(t("account.selfEdit.bankAccount"));
  expect(consoleDesktop).toContain(t("account.selfEdit.correctionPending"));
  expect(consoleDesktop).toContain(t("account.selfEdit.viewProgress"));
  expect(consoleDesktop).toContain(
    t("account.accessLog.viewedField", {
      actor: "HR Team Seoyeon Moon",
      field: t("account.accessLog.field.RRN"),
    }),
  );
  expect(consoleDesktop).toContain(`${t("reason.rrn_reveal.SOCIAL_INSURANCE_FILING")} · 11-03`);

  const consolePhone = renderMe(true);
  expect(consolePhone).not.toContain("<h1");
});

test("MePage adapts cleanly for unlinked tenant and platform vendor accounts", () => {
  state.me.employee_link_status = "UNLINKED";
  const unlinked = renderMe(false);
  expect(unlinked).toContain(t("account.status.unlinked"));
  expect(unlinked).not.toContain(t("account.selfEdit.title"));
  expect(unlinked).not.toContain(t("account.accessLog.title"));

  state.platform = true;
  const vendor = renderMe(false);
  expect(vendor).toContain(t("account.field.platform"));
  expect(vendor).not.toContain(t("account.access.title"));
  expect(vendor).not.toContain("/account/privacy");

  state.platform = false;
  state.me.employee_link_status = "LINKED";
  state.profileError = new ApiError(403, "forbidden", "");
  const refused = renderMe(false);
  expect(refused).toContain(t("account.selfEdit.refused.title"));
});

test("MyAccessCard uses DS Card without legacy raw .toolbar classes", () => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MyAccessCard />
    </QueryClientProvider>,
  );
  client.clear();
  expect(html).toContain('aria-labelledby="acct-access"');
  expect(html).not.toContain("toolbar__title");
  expect(html).not.toContain("card__body");
});

test("the certificate sheet opens from the address, so the phone nav and a shared link reach it", () => {
  expect(renderMe(false)).toContain('data-certificates-sheet="closed"');
  state.search = { sheet: "certificates" };
  expect(renderMe(false)).toContain('data-certificates-sheet="open"');
});
