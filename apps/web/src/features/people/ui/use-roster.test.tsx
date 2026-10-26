// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { RosterOrder } from "../domain/roster-order";
import { useRoster } from "./use-roster";

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@tanstack/react-query", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useInfiniteQuery: vi.fn(() => ({ isFetching: false, isPending: false, isFetchedAfterMount: true, dataUpdatedAt: 0 })),
  useQuery: () => ({ isError: false }),
}));
vi.mock("../../../lib/react/arrival", () => ({ useFreshOnArrival: (query: unknown) => query }));
vi.mock("@console/api", async original => ({ ...await original<object>(), api: { GET: http.get } }));
beforeEach(() => {
  vi.mocked(useInfiniteQuery).mockClear();
  http.get.mockReset().mockResolvedValue({ data: { items: [] }, response: new Response() });
});

function Read({ sort }: { sort?: RosterOrder }) {
  useRoster({ status: "current", review: ["identity"], unit: "department", q: "가상", sort });
  return null;
}

test.each([undefined, "hire_date", "-employee_number"] as const)("the roster continues by server cursor in order %s", async sort => {
  renderToStaticMarkup(<Read sort={sort} />);
  const options = vi.mocked(useInfiniteQuery).mock.calls.at(-1)![0];
  expect(options.initialPageParam).toBeUndefined();
  const read = options.queryFn as (context: { pageParam?: string }) => Promise<unknown>;
  await read({});
  expect(http.get).toHaveBeenLastCalledWith("/api/v1/employees", { params: { query: expect.objectContaining({
    sort: sort ?? "name", limit: 100, search: "가상", org_unit_id: "department", identity_review_required: true,
  }) } });
  await read({ pageParam: "opaque-sort-and-id" });
  const request = http.get.mock.calls.at(-1)![1];
  expect(request).toEqual({ params: { query: expect.objectContaining({ cursor: "opaque-sort-and-id" }) } });
  expect(request?.params?.query).not.toHaveProperty("offset");
  const next = options.getNextPageParam!;
  const page = { items: Array(100).fill({ id: "person" }), total: 2000, next_cursor: "opaque-sort-and-id" };
  expect(next(page, [page], undefined, [undefined])).toBe("opaque-sort-and-id");
  expect(next({ ...page, next_cursor: null }, [page], undefined, [undefined])).toBeUndefined();
});
