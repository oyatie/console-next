// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { orgChangeCountsQuery } from "./api/counts";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@console/api", async original => ({ ...await original<typeof import("@console/api")>(), api: { GET: request }, session: { claims: { sub: "drafter" } } }));
afterEach(() => request.mockReset());
const reply = (data: unknown, status = 200) => ({ data: status === 200 ? data : undefined, error: status === 200 ? undefined : data, response: new Response(null, { status }) });
const totals = { open: 2, mine: 3, approval: 0, ready: 1, done: 1, closed: 0, all: 3 };
const range = { effective_from: "2026-11-01", effective_to: "2026-11-30" };

test("all tab totals come from one authenticated count read with the effective range", async () => {
  request.mockResolvedValue(reply(totals));
  expect(await orgChangeCountsQuery(range).queryFn()).toEqual(totals);
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/v1/org-changes/counts", { params: { query: range } });
});
test.each([400, 403, 503])("a %i count read cannot fall back to list reads", async status => {
  request.mockResolvedValue(reply({ error: { code: "unavailable", message: "unavailable" } }, status));
  await expect(orgChangeCountsQuery().queryFn()).rejects.toBeInstanceOf(ApiError);
  expect(request).toHaveBeenCalledTimes(1);
});
test.each([404, 405, 400])("a legacy %i response uses server-filtered totals behind the count query", async status => {
  request.mockResolvedValueOnce(reply(status === 400 ? { error: { code: "bad_request", message: "요청 형식이 올바르지 않습니다." } } : null, status)).mockResolvedValue(reply({ items: [], total: 4 }));
  expect(await orgChangeCountsQuery(range).queryFn()).toEqual(Object.fromEntries(Object.keys(totals).map(view => [view, 4])));
  expect(request).toHaveBeenCalledTimes(8);
  expect(request).toHaveBeenCalledWith("/api/v1/org-changes", { params: { query: expect.objectContaining({ ...range, drafted_by: "drafter", limit: 1, offset: 0 }) } });
});
test("a partial count response never publishes missing totals as zero", async () => {
  request.mockResolvedValue(reply({ open: 2 }));
  await expect(orgChangeCountsQuery().queryFn()).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
test("one failed legacy view never publishes a partially successful count read", async () => {
  request.mockResolvedValueOnce(reply(null, 404)).mockResolvedValueOnce(reply({ items: [], total: 4 })).mockResolvedValue(reply({ error: { code: "unavailable", message: "unavailable" } }, 503));
  await expect(orgChangeCountsQuery().queryFn()).rejects.toBeInstanceOf(ApiError);
});
