// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "@console/api";
import { orgChangeCountsQuery } from "./api/counts";
import { changesViewQuery, CHANGE_VIEWS, type ChangeView } from "./api";
import { readIdentity } from "../../lib/query";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@console/api", async original => ({ ...await original<typeof import("@console/api")>(), api: { GET: request }, session: { claims: { sub: "drafter" } } }));
afterEach(() => request.mockReset());
const reply = (data: unknown, status = 200) => ({ data: status === 200 ? data : undefined, error: status === 200 ? undefined : data, response: new Response(null, { status }) });
const totals = { open: 2, mine: 3, approval: 0, ready: 1, done: 1, closed: 0, all: 3 };
const range = { effective_from: "2026-11-01", effective_to: "2026-11-30" };

test("tab totals use only contracted list reads with each view's filters and effective range", async () => {
  Object.values(totals).forEach(total => request.mockResolvedValueOnce(reply({ items: [], total })));
  expect(await orgChangeCountsQuery(range).queryFn()).toEqual(totals);
  expect(request.mock.calls).toEqual((Object.keys(CHANGE_VIEWS) as ChangeView[]).map(view => ["/api/v1/org-changes", {
    params: { query: {
      status: CHANGE_VIEWS[view].status.length ? [...CHANGE_VIEWS[view].status] : undefined,
      drafted_by: view === "mine" ? "drafter" : undefined,
      limit: 1, offset: 0, ...range,
    } },
  }]));
});
test("aggregate counts have a distinct cache entry under the list invalidation prefix", () => {
  const counts = readIdentity(orgChangeCountsQuery(range));
  expect(JSON.parse(counts)[0]).toBe("/api/v1/org-changes");
  expect(counts).not.toBe(readIdentity(changesViewQuery("all", 0, 1, range)));
  expect(counts).not.toBe(readIdentity(orgChangeCountsQuery()));
});
test.each([400, 403, 503])("one %i view read rejects the aggregate rather than publishing partial totals", async status => {
  request.mockResolvedValueOnce(reply({ items: [], total: 4 })).mockResolvedValue(reply({ error: { code: "unavailable", message: "unavailable" } }, status));
  await expect(orgChangeCountsQuery().queryFn()).rejects.toBeInstanceOf(ApiError);
  expect(request).toHaveBeenCalledTimes(Object.keys(CHANGE_VIEWS).length);
});
test.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("an invalid list total (%s) is never published", async total => {
  request.mockResolvedValueOnce(reply({ items: [], total })).mockResolvedValue(reply({ items: [], total: 4 }));
  await expect(orgChangeCountsQuery().queryFn()).rejects.toThrow("Incomplete org change counts");
});
