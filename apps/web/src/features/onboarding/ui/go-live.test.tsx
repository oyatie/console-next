import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import type { GoLiveItem } from "@console/api/pending";
import { ApiError } from "../api";
import { GoLive } from "./go-live";

const state = vi.hoisted(() => ({
  readError: null as unknown, commandError: null as unknown, updated: 100, submitted: 200,
  fetching: false, fetched: true, mutate: vi.fn(),
  data: {
    phase: "SETUP", digest: "preview", line_digests: {}, blockers: [] as GoLiveItem[],
    warnings: [{ code: "sole_holder", count: 0, remedy: null, records: [] }], becomes_governed: [],
    breakdown: [{ kind: "workplace", id: "site", legal_entity_id: "entity", name: "Head Office", people: 1982, units: 31 }], roles_becoming_active: [], access_admin_holders: [], hr_accounts_with_no_grant: [],
    facts: { entities: 1, workplaces: 1, org_units: 2, employees: 2000, employees_starting_later: 0,
      setup_writes: 4, prepared_grants: 1, grants_effective_in_setup: 0, hr_accounts_invited: 1, hr_accounts_enrolled: 1 },
  },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => initial === false ? [true, vi.fn()] : react.useState(initial) };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({
  data: state.data, isPending: false, error: state.readError, refetch: vi.fn(),
  dataUpdatedAt: state.updated, isFetching: state.fetching, isFetchedAfterMount: state.fetched, isError: state.readError !== null,
}) }));
vi.mock("../../../lib/react/command", async (original) => ({ ...(await original<typeof import("../../../lib/react/command")>()), useCommand: () => ({
  error: state.commandError, isPending: false, submittedAt: state.submitted, mutate: state.mutate,
}) }));
beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]));
afterEach(() => { i18n.set("ko"); state.readError = null; state.commandError = null; state.updated = 100; state.fetching = false; state.fetched = true; state.data.blockers = []; state.data.facts.org_units = 2; state.mutate.mockClear(); });
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
