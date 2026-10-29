// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { closesQuery, exceptionsQuery, week52Query, dayBoardQuery } from "./api";

const request = vi.hoisted(() => vi.fn());
vi.mock("@console/api", async original => ({ ...await original<typeof import("@console/api")>(), api: { GET: request } }));
afterEach(() => request.mockReset());

test("an older server rejecting rows=all degrades to its compact rows and preserves scope filters", async () => {
  const board = { groups: [] };
  request.mockRejectedValueOnce(new ApiError(400, "invalid_query", "unknown parameter"))
    .mockResolvedValueOnce({ data: board, response: new Response() });
  const query = dayBoardQuery("2026-10-06", "wp", "team", true, true, "all");
  expect(await query.queryFn()).toEqual(board);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]![1]).toEqual({ params: { query: {
    date: "2026-10-06", workplace_id: "wp", unit_id: "team", issues_only: true, no_schedule_only: true, rows: undefined,
  } } });
});

test.each([[403, "forbidden"], [503, "service_unavailable"], [400, "invalid_date"]] as const)("a %s %s never triggers compatibility retry", async (status, code) => {
  const error = new ApiError(status, code, "refused");
  request.mockRejectedValue(error);
  await expect(dayBoardQuery("2026-10-06", undefined, undefined, undefined, undefined, "all").queryFn()).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
});

test("a compact query failure is not retried", async () => {
  const error = new ApiError(400, "invalid_query", "refused");
  request.mockRejectedValue(error);
  await expect(dayBoardQuery("bad date").queryFn()).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
});

test.each(["2026-10-04", "2026-09-28", "2026-10-01"])("week52 uses the containing Monday across month boundaries: %s", async date => {
  request.mockResolvedValue({ data: { items: [] }, response: new Response() });
  await week52Query(date, "place").queryFn();
  expect(request).toHaveBeenCalledWith("/api/v1/attendance/week52", { params: { query: { week_start: "2026-09-28", branch_id: "place" } } });
});
test("close and exception reads carry month and workplace; OPEN pages use response offsets", async () => {
  request.mockResolvedValue({ data: { items: [] }, response: new Response() });
  await closesQuery("2026-10", "place").queryFn();
  expect(request).toHaveBeenCalledWith("/api/v1/attendance/closes", { params: { query: { month: "2026-10", branch_id: "place" } } });
  const query = exceptionsQuery("2026-10", "place");
  request.mockResolvedValue({ data: { items: [], total: 0, offset: 2, limit: 2 }, response: new Response() });
  await query.queryFn({ pageParam: 2 });
  expect(request).toHaveBeenCalledWith("/api/v1/attendance/exceptions", { params: { query: { month: "2026-10", branch_id: "place", status: "OPEN", offset: 2 } } });
  expect(query.getNextPageParam({ offset: 0, limit: 2, total: 3, items: [{}, {}] } as never)).toBe(2);
  expect(query.getNextPageParam({ offset: 2, limit: 2, total: 3, items: [{}] } as never)).toBeUndefined();
  expect(query.getNextPageParam({ offset: 0, limit: 2, total: 3, items: [] })).toBeUndefined();
});

test("an impossible URL date reaches server validation without normalization", async () => {
  const error = new ApiError(422, "invalid_date", "invalid date");
  request.mockRejectedValue(error);
  await expect(week52Query("2026-02-30").queryFn()).rejects.toBe(error);
  expect(request).toHaveBeenCalledWith("/api/v1/attendance/week52", { params: { query: { week_start: "2026-02-30", branch_id: undefined } } });
});
