// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { i18n, loadCatalog } from "@console/i18n";
import { get } from "../../../lib/query";
import { Members } from "./structure-members";
import { Sec } from "./panel-shell";

let currentOrgUnit: unknown = undefined;
let orgPending = false;
type Employee = { id: string; name: string; status: string; employee_number: string; org_unit_id: string | null; org_unit?: string; company?: string };
const UNIT = "00000000-0000-0000-0000-000000000001";
let currentEmployees: { items: Employee[]; total: number; limit: number; offset: number; next_cursor: null } | undefined;
let canRead = true;
let employeeError: { status: number; code: string } | null = null;
let employeePending = false;
let employeeReads: Record<string, unknown>[] = [];
const employeeRefetch = vi.fn();

vi.mock("../../authz/ui/use-can", () => ({ useCan: () => () => canRead }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

vi.mock("../../../lib/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/query")>();
  return {
    ...actual,
    get: (...args: Parameters<typeof actual.get>) => ({ ...actual.get(...args), path: args[0], params: args[1]?.params }),
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: Record<string, unknown>) => {
      if (options.path === "/api/v1/org-structure/units/{orgUnitId}/members") {
        return { data: (currentOrgUnit as { members?: unknown } | undefined)?.members, isPending: orgPending };
      }
      if (options.path === "/api/v1/employees") {
        employeeReads.push(options);
        // A server honours the filters: the count and rows come only from matching employees.
        const { query } = options.params as { query: { org_unit_id: string; status: string[]; sort?: string; limit: number } };
        const matching = currentEmployees?.items.filter((e) =>
          (e.org_unit_id === query.org_unit_id || e.org_unit === query.org_unit_id) && query.status.includes(e.status));
        const items = matching?.toSorted((a, b) =>
          (query.sort === "name" ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id) :
            (a.company ?? "").localeCompare(b.company ?? "") || a.name.localeCompare(b.name)));
        return {
          data: !currentEmployees ? undefined : { ...currentEmployees, total: matching!.length, items: items?.slice(0, query.limit) },
          isPending: employeePending,
          isError: Boolean(employeeError),
          error: employeeError,
          refetch: employeeRefetch,
        };
      }
      return { data: undefined, isPending: false };
    },
    useQueryClient: () => ({
      getQueryState: () => undefined,
    }),
  };
});

beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]));
afterEach(() => i18n.set("ko"));
beforeEach(() => {
  currentOrgUnit = { members: { headcount: 0, items: [] } };
  orgPending = false;
  currentEmployees = undefined;
  canRead = true;
  employeeError = null;
  employeePending = false;
  employeeReads = [];
  employeeRefetch.mockReset();
});

test("a workplace with one future joiner renders 직속 0명 and a separate 입사 예정 1명", () => {
  futureJoiner();

  const html = renderToStaticMarkup(
    <Sec id="wp-people" title="사업장 직속 0명">
      <Members unitId={UNIT} total={0} expected={0} />
    </Sec>
  );

  expect(html).toContain("직속 0명");
  expect(html).toContain("입사 예정 1명");
  expect(employeeReads[0]?.params).toMatchObject({ query: { org_unit_id: UNIT, status: ["PRE_HIRE"] } });
});

test("a workplace with zero future joiners does not render 입사 예정", () => {
  const unitId = "00000000-0000-0000-0000-000000000002";
  currentEmployees = { items: [], total: 0, limit: 100, offset: 0, next_cursor: null };

  const html = renderToStaticMarkup(
    <Sec id="wp-people" title="사업장 직속 0명">
      <Members unitId={unitId} total={0} expected={0} />
    </Sec>
  );

  expect(html).toContain("직속 0명");
  expect(html).not.toContain("입사 예정");
  expect(html).toContain("바로 배치된 사람이 없습니다");
});

const renderMembers = () => renderToStaticMarkup(<Members unitId={UNIT} total={0} expected={0} />);

function futureJoiner() {
  currentOrgUnit = { members: { headcount: 0, items: [{ employeeId: "e1", name: "김예시" }] } };
  currentEmployees = {
    items: [
      { id: "e1", name: "김예시", status: "PRE_HIRE", employee_number: "E-001", org_unit_id: UNIT },
      { id: "e2", name: "박재직", status: "ACTIVE", employee_number: "E-002", org_unit_id: UNIT },
      { id: "e3", name: "최다른", status: "PRE_HIRE", employee_number: "E-003", org_unit_id: "00000000-0000-0000-0000-000000000009" },
    ],
    total: 3, limit: 100, offset: 0, next_cursor: null,
  };
}

test("org-only readers do not request the directory or treat unavailable counts as zero, even with cached data", () => {
  futureJoiner();
  canRead = false;
  const html = renderMembers();
  expect(employeeReads.filter((read) => read.enabled !== false)).toHaveLength(0);
  expect(html).toContain("입사 예정 인원을 보려면 직원 목록 조회 권한이 필요합니다");
  expect(html).toContain("김예시");
  expect(html).not.toContain("입사 예정 0명");
  expect(html).not.toContain("입사 예정 1명");
  const rows = html.match(/<li>.*?<\/li>/g) ?? [];
  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toContain("입사 예정");
});

test("a legacy UUID-text placement in the preview keeps its count and badge", () => {
  futureJoiner();
  currentEmployees!.items[0]!.org_unit_id = null;
  currentEmployees!.items[0]!.org_unit = UNIT;
  const html = renderMembers();
  expect(html).toContain("입사 예정 1명");
  expect(html.match(/<li>.*?<\/li>/)?.[0]).toContain("입사 예정");
});

test("an unbound workplace does not request joiners or show a directory notice", () => {
  const html = renderToStaticMarkup(<Members total={0} expected={0} />);
  expect(employeeReads).toHaveLength(1);
  expect(employeeReads[0]!.enabled).toBe(false);
  expect(html).not.toContain("입사 예정");
  expect(html).not.toContain("불러오는 중");
});

test("a visible joiner beyond the first company-ordered page keeps its badge and the full count", () => {
  currentOrgUnit = { members: { headcount: 0, items: [{ employeeId: "late", name: "가예정" }] } };
  currentEmployees = {
    items: [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `a-${i}`, name: `나예정${i}`, company: "A", status: "PRE_HIRE", employee_number: `E-${i}`, org_unit_id: UNIT })),
      { id: "late", name: "가예정", company: "Z", status: "PRE_HIRE", employee_number: "E-101", org_unit_id: UNIT },
    ],
    total: 101, limit: 100, offset: 0, next_cursor: null,
  };
  const html = renderMembers();
  expect(html).toContain("입사 예정 101명");
  const row = html.match(/<li>.*?<\/li>/)?.[0];
  expect(row).toContain("가예정");
  expect(row).toContain("입사 예정");
});

test("all eight visible joiners keep their badges when names tie across companies", () => {
  const joiners = Array.from({ length: 101 }, (_, i) => ({
    id: `e-${String(i).padStart(3, "0")}`, name: "김예시", company: i < 8 ? "Z" : "A", status: "PRE_HIRE", employee_number: `E-${i}`, org_unit_id: UNIT,
  }));
  currentOrgUnit = { members: { headcount: 0, items: joiners.slice(0, 8).map((e) => ({ employeeId: e.id, name: e.name })) } };
  currentEmployees = { items: joiners, total: 101, limit: 100, offset: 0, next_cursor: null };
  const html = renderMembers();
  const rows = html.match(/<li>.*?<\/li>/g) ?? [];
  expect(rows).toHaveLength(8);
  for (const row of rows) expect(row).toContain("입사 예정");
  expect(html).toContain("입사 예정 101명");
});

test.each([["ko", 403], ["ko", 503], ["en", 403], ["en", 503]] as const)("a %s directory %s failure shows an unavailable count and retry while keeping members", (locale, status) => {
  i18n.set(locale);
  futureJoiner();
  currentEmployees = undefined;
  employeeError = { status, code: status === 403 ? "forbidden" : "unavailable" };
  const html = renderMembers();
  expect(html).toContain(locale === "ko" ? "입사 예정 인원을 불러오지 못했습니다" : "Could not load the upcoming joiner count");
  expect(html).toContain(locale === "ko" ? "다시 불러오기" : "Reload");
  expect(html).not.toContain(locale === "ko" ? "바로 배치된 사람이 없습니다" : "Nobody is placed directly here");
  expect(html).toContain("김예시");
  expect(html).not.toContain("입사 예정 0명");
  expect(html.match(/<button[^>]*>/)?.[0]).not.toMatch(/\sdisabled=/);
});

test("a pending directory read shows loading instead of treating the count as zero", () => {
  employeePending = true;
  const html = renderMembers();
  expect(html).toContain("입사 예정");
  expect(html).toContain("불러오는 중");
  expect(html).not.toContain("입사 예정 0명");
  expect(html).not.toContain("바로 배치된 사람이 없습니다");
});

test("pending known members hold their rows without announcing an empty workplace", () => {
  currentOrgUnit = undefined;
  orgPending = true;
  employeePending = true;
  const html = renderToStaticMarkup(<Members unitId={UNIT} total={3} expected={3} />);
  expect(html).toContain('aria-busy="true"');
  expect(html.match(/<li>/g)).toHaveLength(3);
  expect(html).not.toContain("바로 배치된 사람이 없습니다");
});

test("Hangul and HTML-like names stay escaped without changing the joiner count", () => {
  futureJoiner();
  const name = '김<script>alert("x")</script>😀';
  currentOrgUnit = { members: { headcount: 0, items: [{ employeeId: "e1", name }] } };
  currentEmployees!.items[0]!.name = name;
  const html = renderMembers();
  expect(html).toContain("입사 예정 1명");
  expect(html).toContain("김&lt;script&gt;");
  expect(html).not.toContain("<script>");
});

test("a forbidden refetch hides cached directory counts and badges while keeping org members", async () => {
  futureJoiner();
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const client = new QueryClient();
  const descriptor = { ...get("/api/v1/employees"), queryFn: async () => currentEmployees };
  await client.fetchQuery(descriptor);
  const observer = new QueryObserver(client, {
    ...descriptor,
    queryFn: async () => { throw { status: 403, code: "forbidden" }; },
    enabled: false,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const refused = await observer.refetch();
    expect(refused.isError).toBe(true);
    expect(refused.error).toMatchObject({ status: 403, code: "forbidden" });
    currentEmployees = refused.data as typeof currentEmployees;
    employeeError = refused.error as typeof employeeError;
    expect(currentEmployees?.items[0]?.id).toBe("e1");
    const html = renderMembers();
    expect(html).toContain("입사 예정 인원을 불러오지 못했습니다");
    expect(html).toContain("김예시");
    expect(html).not.toContain("입사 예정 1명");
    expect(html.match(/<li>.*?<\/li>/)?.[0]).not.toContain("입사 예정");
  } finally {
    unsubscribe(); client.clear();
  }
});
