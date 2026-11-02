// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { RosterOrder } from "../domain/roster-order";
import { PAGE, useRoster } from "./use-roster";

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@tanstack/react-query", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useInfiniteQuery: vi.fn(() => ({ isFetching: false, isPending: false, isFetchedAfterMount: true, dataUpdatedAt: 0 })),
  useQuery: vi.fn(() => ({ isError: false })),
}));
vi.mock("../../../lib/react/arrival", () => ({ useFreshOnArrival: (query: unknown) => query }));
vi.mock("@console/api", async original => ({ ...await original<object>(), api: { GET: http.get } }));
beforeEach(() => {
  vi.mocked(useInfiniteQuery).mockClear();
  vi.mocked(useQuery).mockClear();
  http.get.mockReset().mockResolvedValue({ data: { items: [] }, response: new Response() });
});

test("roster reads wait for the configured window without inventing a filter", () => {
  function PendingWindow() {
    const result = useRoster({ status: "current", review: ["contractSoon"] }, undefined);
    expect(result.loading).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.total).toBeUndefined();
    return null;
  }
  renderToStaticMarkup(<PendingWindow />);
  expect(vi.mocked(useInfiniteQuery).mock.calls.at(-1)![0].enabled).toBe(false);
  expect(vi.mocked(useQuery).mock.calls.every(([options]) => options!.enabled === false)).toBe(true);
});

function Read({ sort }: { sort?: RosterOrder }) {
  useRoster({ status: "current", review: ["identity"], unit: "department", q: "가상", sort }, 21);
  return null;
}

test("a sort read retains rows and the total while pausing pagination", () => {
  const rows = [{ id: "person" }];
  vi.mocked(useInfiniteQuery).mockReturnValueOnce({
    isFetching: true, isPending: false, isFetchedAfterMount: true, isPlaceholderData: true,
    data: { pages: [{ items: rows, total: 2000, next_cursor: "previous-order" }] },
  } as unknown as ReturnType<typeof useInfiniteQuery>);
  function SortRead() {
    const result = useRoster({ status: "current", review: [], sort: "employee_number" }, 21);
    expect(result.rows).toEqual(rows);
    expect(result.total).toBe(2000);
    expect(result.loading).toBe(true);
    return null;
  }
  renderToStaticMarkup(<SortRead />);
});

test("the configured contract window reaches the server filter", async () => {
  function ContractRead() {
    useRoster({ status: "current", review: ["contractSoon"] }, 21);
    return null;
  }
  renderToStaticMarkup(<ContractRead />);
  const options = vi.mocked(useInfiniteQuery).mock.calls.at(-1)![0];
  const read = options.queryFn as (context: { pageParam?: string }) => Promise<unknown>;
  await read({});
  const { addDays } = await import("../domain/roster");
  const { todayKst } = await import("../../../lib/pure/today");
  expect(http.get.mock.calls.at(-1)![1].params.query.contract_ending_before).toBe(addDays(todayKst(), 22));
});

test.each([undefined, "hire_date", "-employee_number"] as const)("the roster continues by server cursor in order %s", async sort => {
  renderToStaticMarkup(<Read sort={sort} />);
  const options = vi.mocked(useInfiniteQuery).mock.calls.at(-1)![0];
  expect(options.initialPageParam).toBeUndefined();
  const read = options.queryFn as (context: { pageParam?: string }) => Promise<unknown>;
  await read({});
  expect(http.get).toHaveBeenLastCalledWith("/api/v1/employees", { params: { query: expect.objectContaining({
    sort: sort ?? "name", limit: PAGE, search: "가상", org_unit_id: "department", identity_review_required: true,
  }) } });
  await read({ pageParam: "opaque-sort-and-id" });
  const request = http.get.mock.calls.at(-1)![1];
  expect(request).toEqual({ params: { query: expect.objectContaining({ cursor: "opaque-sort-and-id" }) } });
  expect(request?.params?.query).not.toHaveProperty("offset");
  const next = options.getNextPageParam!;
  const page = { items: Array(PAGE).fill({ id: "person" }), total: 2000, next_cursor: "opaque-sort-and-id" };
  expect(next(page, [page], undefined, [undefined])).toBe("opaque-sort-and-id");
  expect(next({ ...page, next_cursor: null }, [page], undefined, [undefined])).toBeUndefined();
});
