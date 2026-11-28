// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ApiError } from "../../../reference/authz/api";
import { TeamPage } from "./team-page";
import { TeamRecordPane } from "./team-record-pane";

const state = vi.hoisted(() => ({
  search: {} as { view?: "all" | "direct" | "concurrent"; scopeId?: string; status?: "all" | "ACTIVE" | "ON_LEAVE" | "SOON" | "MISSING"; q?: string; sel?: string },
  paths: [] as string[],
  refused: false,
  canManage: false,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-to={to}>{children}</span>,
  getRouteApi: () => ({
    useNavigate: () => vi.fn(),
    useSearch: () => state.search,
  }),
}));

vi.mock("../../../experience/dom", () => ({
  useActiveExperienceId: () => "console",
}));

vi.mock("@tanstack/react-query", async original => {
  const actual = await original<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useInfiniteQuery: (opts: Record<string, unknown>) => {
      const first = Object.values(opts).find(Array.isArray);
      const path = String(first?.[0] ?? "");
      state.paths.push(path);
      if (state.refused) {
        return {
          isPending: false,
          error: new ApiError(403, "directory.refuse.missing_grant", "Refused"),
          data: undefined,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
        };
      }
      return {
        isPending: false,
        error: null,
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
        refetch: vi.fn(),
        data: {
          pages: [
            {
              total: state.search.view === "direct" ? 300 : 2,
              items: [
                {
                  id: "e1",
                  company: "Saeon Precision",
                  name: "Minjae Kim",
                  employee_number: "10012",
                  org_unit: "Prod Team 1",
                  org_unit_id: "d1",
                  position: "Lead",
                  employment_type: "REGULAR",
                  status: "ACTIVE",
                  updated_at: "2026-11-10T00:00:00Z",
                },
                {
                  id: "e2",
                  company: "Saeon Precision",
                  name: "Seoyeon Park",
                  employee_number: "10088",
                  org_unit: "Plant 2",
                  org_unit_id: "w2",
                  position: "Supervisor",
                  employment_type: "REGULAR",
                  status: "ON_LEAVE",
                  updated_at: "2026-11-10T00:00:00Z",
                },
              ],
            },
          ],
        },
      };
    },
    useQuery: (opts: Record<string, unknown>) => {
      const first = Object.values(opts).find(Array.isArray);
      const path = String(first?.[0] ?? "");
      if (opts.enabled !== false) state.paths.push(path);
      if (path.includes("/api/v1/access/me")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: {
            is_ops: false,
            phase: "OPERATING",
            entries: [
              {
                grant_id: "g1",
                role_id: "r1",
                role_name_ko: "Team",
                domain: "hr_basic",
                level: state.canManage ? "edit" : "view",
                enforcement: "ENFORCED",
                valid_from: "2026-01-01T00:00:00Z",
                scope: { kind: "DEPARTMENT", node_id: "d1", node_name: "Prod Team 1", include_descendants: true },
                caveats: [],
              },
              {
                grant_id: "g2",
                role_id: "r1",
                role_name_ko: "Team",
                domain: "hr_basic",
                level: "view",
                enforcement: "ENFORCED",
                valid_from: "2026-01-01T00:00:00Z",
                scope: { kind: "WORKPLACE", node_id: "w2", node_name: "Plant 2", include_descendants: true },
                caveats: [],
              },
            ],
            decisions: {},
          },
        };
      }
      if (path.includes("/api/v1/users/me")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: { id: "u1", employee_org_unit: "Prod Team 1", employee_org_unit_id: "d1", tenant: { name: "Saeon Group", phase: "OPERATING" } },
        };
      }
      if (path.includes("/api/v1/employees/facets")) {
        return {
          isPending: false,
          error: null,
          refetch: vi.fn(),
          data: {
            total: 2,
            status: [
              { value: "ACTIVE", count: 1 },
              { value: "ON_LEAVE", count: state.search.view === "direct" ? 0 : 1 },
            ],
            review: { contract_ending_before: 0 },
          },
        };
      }
      if (path.includes("/api/v2/leave/requests")) {
        return { isPending: false, error: null, data: { items: [] }, refetch: vi.fn() };
      }
      return { isPending: false, error: null, data: undefined, refetch: vi.fn() };
    },
  };
});

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.search = {};
  state.paths = [];
  state.refused = false;
  state.canManage = false;
});

function renderTeam() {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TeamPage />
    </QueryClientProvider>,
  );
}

test("team page renders cedar-scoped views and never calls org-structure", () => {
  const html = renderTeam();
  expect(html).toContain(t("team.title"));
  expect(html).toContain(t("team.view.all"));
  expect(html).toContain(t("team.view.direct"));
  expect(html).toContain(t("team.view.concurrent"));
  expect(html).toContain("Minjae Kim");
  expect(state.paths.some(p => p.includes("org-structure"))).toBe(false);
});

test("team record pane gates all management actions behind Cedar hr_basic edit access", () => {
  const member = {
    id: "e1",
    company: "Saeon Precision",
    name: "Minjae Kim",
    employee_number: "10012",
    org_unit: "Prod Team 1",
    org_unit_id: "d1",
    position: "Lead",
    employment_type: "REGULAR",
    status: "ACTIVE",
    updated_at: "2026-11-10T00:00:00Z",
  } as const;
  const qc = new QueryClient();
  state.canManage = false;
  const viewOnlyHtml = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TeamRecordPane member={member as never} leaveRequests={[]} />
    </QueryClientProvider>,
  );
  expect(viewOnlyHtml).toContain(t("team.pane.action.openCard"));
  expect(viewOnlyHtml).not.toContain(t("team.pane.action.appoint"));
  expect(viewOnlyHtml).not.toContain(t("team.pane.action.leave"));
  expect(viewOnlyHtml).not.toContain(t("team.pane.action.changeRequest"));

  state.canManage = true;
  const manageHtml = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TeamRecordPane member={member as never} leaveRequests={[]} />
    </QueryClientProvider>,
  );
  expect(manageHtml).toContain(t("team.pane.action.appoint"));
  expect(manageHtml).toContain(t("team.pane.action.leave"));
  expect(manageHtml).toContain(t("team.pane.action.changeRequest"));
});

test("team page updates StatRow and table total counts when direct view has more matching rows than the current page", () => {
  state.search = { view: "direct" };
  const html = renderTeam();
  expect(html).toContain("Minjae Kim");
  expect(html).not.toContain("Seoyeon Park");
  expect(html).toContain('data-total="300"');
  expect(html).toMatch(new RegExp(`${t("team.stats.total")}</dt><dd[^>]*>300</dd>`));
  expect(html).toMatch(new RegExp(`${t("team.stats.onLeave")}</button></dt><dd[^>]*>0</dd>`));
});

test("team page shows PageReadGate on 403 refusal", () => {
  state.refused = true;
  const html = renderTeam();
  expect(html).toContain(t("team.title"));
  expect(html).toContain("directory.refuse.missing_grant");
});
