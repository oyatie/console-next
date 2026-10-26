// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { dayBoardQuery } from "./api";

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
