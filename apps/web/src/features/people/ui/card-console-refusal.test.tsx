// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { ApiError } from "../../../reference/authz/api";
import type { ReadState } from "../../../lib/react/query-view";
import { CardConsole } from "./card-console";
import { nextConsoleCardRefusal } from "./use-card-refusal";

type Detail = components["schemas"]["EmployeeDetail"];

const state = { act: "print" as string | undefined };

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  getRouteApi: () => ({
    useParams: () => ({ id: "emp-1" }),
    useSearch: () => ({ act: state.act }),
    useNavigate: () => () => {},
  }),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../../../experience/dom", async original => ({
  ...await original<typeof import("../../../experience/dom")>(),
  useActiveExperienceId: () => "console" as const,
}));

beforeAll(() => loadCatalog("ko"));

const privateName = "Private Employee";
const cachedDetail: Detail = {
  employee: {
    id: "emp-1",
    person_id: "emp-1",
    company: "Saeon Precision",
    name: privateName,
    employee_number: "99001",
    org_unit_id: null,
    legal_entity_id: null,
    workplace_id: null,
    status: "ACTIVE",
    home_branch_review_required: false,
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    next_event: null,
    failed_event: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  classification: {},
  allowed_events: [],
  allowed_scheduled_events: [],
  warnings: [],
} as unknown as Detail;

describe("CardConsole print refusal guard", () => {
  test.each([403, 404])("?act=print with cached detail.data and %s error renders refusal state and never ConsolePrintHost", status => {
    state.act = "print";
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
    const detail: ReadState<Detail> = {
      isPending: false,
      error: new ApiError(status, status === 403 ? "forbidden" : "not_found", "lost"),
      data: cachedDetail,
      refetch: () => {},
    };
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CardConsole id="emp-1" detail={detail} loading={false} opened="emp-1" baseline={() => <div data-baseline="" />} />
      </QueryClientProvider>,
    );
    expect(html).toContain(t(status === 403 ? "common.denied.title.plain" : "common.read.notFound.title"));
    expect(html).not.toContain(privateName);
    expect(html).not.toContain("99001");
    client.clear();
  });

  test("?act=print with ready detail.data does not render refusal state", () => {
    state.act = "print";
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
    const detail: ReadState<Detail> = {
      isPending: false,
      error: null,
      data: cachedDetail,
      refetch: () => {},
    };
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CardConsole id="emp-1" detail={detail} loading={false} opened="emp-1" baseline={() => <div data-baseline="" />} />
      </QueryClientProvider>,
    );
    expect(html).not.toContain(t("common.denied.title.plain"));
    expect(html).not.toContain(t("common.read.notFound.title"));
    client.clear();
  });

  test("nextConsoleCardRefusal latches 403/404 across placeholderData until non-placeholder ready data arrives", () => {
    const err403 = new ApiError(403, "forbidden", "lost");
    const latched = nextConsoleCardRefusal(
      { isPending: false, error: err403, data: cachedDetail, refetch: () => {} },
      null,
    );
    expect(latched).toBe(err403);

    const duringPlaceholder = nextConsoleCardRefusal(
      { isPending: false, isPlaceholderData: true, error: null, data: cachedDetail, refetch: () => {} },
      latched,
    );
    expect(duringPlaceholder).toBe(err403);

    const afterReady = nextConsoleCardRefusal(
      { isPending: false, isPlaceholderData: false, error: null, data: cachedDetail, refetch: () => {} },
      duringPlaceholder,
    );
    expect(afterReady).toBeNull();
  });
});
