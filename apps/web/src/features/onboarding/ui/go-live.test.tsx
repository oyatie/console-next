import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import type { GoLiveItem } from "@console/api/pending";
import { ApiError } from "../api";
import { GoLive } from "./go-live";

const state = vi.hoisted(() => ({
  receiptError: null as unknown,
  snapshot: { entities: 7, workplaces: 3, staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0, org_units: 8, employees: 42, employees_starting_later: 0, setup_writes: 9 } as object | null,
  readError: null as unknown, commandError: null as unknown, updated: 100, submitted: 200,
  fetching: false, fetched: true, mutate: vi.fn(),
  data: {
    phase: "SETUP", digest: "preview", line_digests: {}, blockers: [] as GoLiveItem[],
    warnings: [{ code: "sole_holder", count: 0, remedy: null, records: [] }], becomes_governed: [] as string[],
    breakdown: [{ kind: "workplace", id: "site", legal_entity_id: "entity", name: "Head Office", people: 1982, units: 31 }], roles_becoming_active: [], access_admin_holders: [], hr_accounts_with_no_grant: [],
    facts: { entities: 1, workplaces: 1, staffed_workplaces_without_registration: 1, empty_workplaces_without_registration: 2, org_units: 2, employees: 2000, employees_starting_later: 0,
      setup_writes: 4, prepared_grants: 1, grants_effective_in_setup: 0, hr_accounts_invited: 1, hr_accounts_enrolled: 1 },
  },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => initial === false ? [true, vi.fn()] : react.useState(initial) };
});
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}), useQuery: (opts: { queryKey: readonly unknown[] }) => opts.queryKey[0] === "/api/v1/onboarding/go-live/receipt" ? {
  data: state.receiptError ? undefined : { go_live_at: "2026-11-04T09:00:00Z", preview_digest: "recorded-digest", facts_snapshot: state.snapshot, facts_snapshot_version: state.snapshot ? 1 : null },
  isPending: false, isError: !!state.receiptError, error: state.receiptError, refetch: vi.fn(),
} : ({
  data: state.data, isPending: false, error: state.readError, refetch: vi.fn(),
  dataUpdatedAt: state.updated, isFetching: state.fetching, isFetchedAfterMount: state.fetched, isError: state.readError !== null,
}) }));
vi.mock("../../../lib/react/command", async (original) => ({ ...(await original<typeof import("../../../lib/react/command")>()), useCommand: () => ({
  error: state.commandError, isPending: false, submittedAt: state.submitted, mutate: state.mutate,
}) }));
beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]));
afterEach(() => { i18n.set("ko"); state.readError = null; state.commandError = null; state.updated = 100; state.fetching = false; state.fetched = true; state.receiptError = null; state.snapshot = { entities: 7, workplaces: 3, staffed_workplaces_without_registration: 0, empty_workplaces_without_registration: 0, org_units: 8, employees: 42, employees_starting_later: 0, setup_writes: 9 }; state.data.phase = "SETUP"; state.data.digest = "preview"; state.data.blockers = []; state.data.becomes_governed = []; state.data.facts.org_units = 2; state.mutate.mockClear(); });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/setup/go-live"] }) });
const render = () => renderToStaticMarkup(<RouterContextProvider router={router}><GoLive /></RouterContextProvider>);

test("a missing department blocks launch and links to adding one until the preview is ready", () => {
  state.data.facts.org_units = 0;
  state.data.blockers = [{ code: "no_department", count: 0, remedy: "add_department", records: [] }];
  const blocked = render();
  expect(blocked).toContain("등록된 부서가 없습니다");
  expect(blocked).toContain('href="/org"');
  expect(blocked).toContain("부서 추가");
  expect(blocked).toContain('aria-disabled="true"');
  expect(blocked).not.toContain('<button type="button" class="btn btn--primary">운영 시작</button>');
  state.data.facts.org_units = 1;
  state.data.blockers = [];
  expect(render()).toContain('<button type="button" class="btn btn--primary">운영 시작</button>');
  expect(state.mutate).not.toHaveBeenCalled();
});

test("a missing department renders its blocker and remedy in English", () => {
  i18n.set("en");
  state.data.facts.org_units = 0;
  state.data.blockers = [{ code: "no_department", count: 0, remedy: "add_department", records: [] }];
  const blocked = render();
  expect(blocked).toContain("No department registered");
  expect(blocked).toContain("Add a department");
  expect(blocked).toContain('href="/org"');
  expect(blocked).toContain('aria-disabled="true"');
});

test("arrival waits for the fresh preview before showing cached records or launch controls", () => {
  state.fetched = false; state.fetching = true;
  const pending = render();
  expect(pending).toContain('role="status"');
  expect(pending).not.toContain("2,000");
  expect(pending).not.toContain("Head Office");
  expect(pending).not.toContain('class="btn btn--primary"');
  state.fetched = true; state.fetching = false;
  expect(render()).toContain("Head Office");
  expect(state.mutate).not.toHaveBeenCalled();
});

test("the facts panel names how many workplaces still need a registration answer", () => {
  expect(render()).toContain("사업자등록 답변 대기");
  expect(render()).toContain(">3<");
});

test("session expiry preserves the last preview and sole-holder acknowledgement without running a write", () => {
  state.readError = new ApiError(401, "unauthorized", "expired");
  const html = render();
  expect(html).toContain("2,000");
  expect(html).toContain(">1,982<");
  expect(html).toContain(">31<");
  expect(html).toContain('type="checkbox" checked=""');
  expect(html).toContain("되돌리기가 정정으로 바뀝니다");
  expect(state.mutate).not.toHaveBeenCalled();
});

test("a background preview refresh disarms launch until the current digest is displayed", () => {
  state.fetching = true;
  const waiting = render();
  expect(waiting).toContain("새 운영 시작 미리보기를 읽고 있습니다");
  expect(waiting).toContain('aria-disabled="true"');
  state.fetching = false;
  expect(render()).toContain('<button type="button" class="btn btn--primary">운영 시작</button>');
  expect(state.mutate).not.toHaveBeenCalled();
});

test("preview_stale marks changed lines, waits for a fresh read, then re-arms with the ack kept", () => {
  state.commandError = ApiError.fromBody(new Response(null, { status: 409 }), {
    error: { code: "preview_stale", message: "stale", details: { digest: "fresh", changed_codes: ["breakdown"] } },
  });
  const waiting = render();
  expect(waiting).toContain("새 운영 시작 미리보기를 읽고 있습니다");
  expect(waiting).toContain("바뀐 항목");
  expect(waiting).toContain('type="checkbox" checked=""');
  state.updated = 300;
  const fresh = render();
  expect(fresh).not.toContain("새 운영 시작 미리보기를 읽고 있습니다");
  expect(fresh).toContain('<button type="button" class="btn btn--primary">운영 시작</button>');
  expect(state.mutate).not.toHaveBeenCalled();
});

test("blockers render as compact alert rows with reason disclosure and without repeated unblocker lists", () => {
  state.data.blockers = [
    { code: "terms_not_accepted", count: null, remedy: "accept_terms", records: [] },
    { code: "no_department", count: 0, remedy: "add_department", records: [] },
  ];
  const html = render();
  expect(html.match(/role="alert"/g)).toHaveLength(2);
  expect(html).toContain("onboarding.refuse.terms_not_accepted");
  expect(html).toContain("onboarding.refuse.no_department");
  expect(html).toContain("이유 보기");
  expect(html).not.toContain("해결할 수 있는 사람");
  expect(html).not.toContain("지금 로그인한 사람");
});

test("operating phase renders the go-live receipt with recorded values and history link instead of an already_operating blocker", () => {
  state.data.phase = "OPERATING";
  state.data.digest = "sha256:receipt-digest-01";
  state.data.becomes_governed = ["setup_undo_becomes_correction", "exits_leave_payroll_available"];
  state.data.blockers = [{ code: "already_operating", count: null, remedy: null, records: [] }];
  const html = render();
  expect(html).toContain("운영을 시작했습니다");
  expect(html).not.toContain("sha256:receipt-digest-01");
  expect(html).toContain("운영 시작 당시");
  expect(html).toContain(">42<");
  expect(html).not.toContain(">2,000<");
  expect(html).toContain('dateTime="2026-11-04T09:00:00Z"');
  expect(html).not.toContain("운영을 시작하면 바뀌는 것");
  expect(html).not.toContain("운영 시작부터 적용되는 역할");
  expect(html).toContain("퇴직, 휴직, 급여 확정을 사용할 수 있습니다");
  expect(html).not.toContain("할 수 있게 됩니다");
  expect(html).toContain('href="/org/history"');
  expect(html).not.toContain("이미 운영 중입니다");
  expect(html).not.toContain('aria-disabled="true"');
  expect(html).not.toContain(">운영 시작</button>");
});

test("the setup preview keeps its command digest off screen", () => {
  state.data.digest = "sha256:preview-only";
  expect(render()).not.toContain("sha256:preview-only");
});

for (const locale of ["ko", "en"] as const) {
  test(`legacy and missing receipts are honest in ${locale}`, () => {
    i18n.set(locale);
    state.data.phase = "OPERATING";
    state.snapshot = null;
    const html = render();
    expect(html).toContain(locale === "ko" ? "운영 시작 당시의 수치는 기록되지 않았습니다" : "Counts at the start of operations were not recorded");
    expect(html).not.toContain(">2,000<");
    state.receiptError = new ApiError(404, "go_live_receipt_not_found", "missing");
    expect(render()).toContain(locale === "ko" ? "저장된 운영 시작 기록이 없습니다" : "No stored start record is available");
  });
}
