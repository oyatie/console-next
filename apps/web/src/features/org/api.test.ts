import { afterEach, expect, test, vi } from "vitest";
import { get } from "../../lib/query";
import { scheduledUnitChangesQuery, myChangesQuery } from "./api";

vi.mock("../../lib/query", async (original) => ({ ...await original<typeof import("../../lib/query")>(), get: vi.fn() }));
const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock("@console/api", async (original) => {
  const actual = await original<typeof import("@console/api")>();
  return { ...actual, api: { GET: fetchPage } };
});
afterEach(() => fetchPage.mockReset());

test("personal redrafts forward the effective-date bounds to the shared query builder", () => {
  const range = { effective_from: "2026-03-01", effective_to: "2026-03-31" };
  myChangesQuery(range);
  expect(get).toHaveBeenLastCalledWith("/api/v1/org-changes", {
    params: { query: expect.objectContaining(range) },
  });
  myChangesQuery();
  expect(get).toHaveBeenLastCalledWith("/api/v1/org-changes", {
    params: { query: expect.not.objectContaining(range) },
  });
});

test("a unit timeline reads every target-filtered page before publishing the result", async () => {
  const page = (items: { id: string }[], total: number) => ({ data: { items, total }, response: new Response(null, { status: 200 }) }) as never;
  const read = fetchPage.mockResolvedValueOnce(page([{ id: "one" }], 2)).mockResolvedValueOnce(page([{ id: "two" }], 2));
  const query = scheduledUnitChangesQuery("unit");
  expect(await query.queryFn()).toEqual([{ id: "one" }, { id: "two" }]);
  expect(read).toHaveBeenNthCalledWith(1, "/api/v1/org-changes", { params: { query: expect.objectContaining({ status: ["APPROVED"], target_ref: "unit", offset: 0 }) } });
  expect(read).toHaveBeenNthCalledWith(2, "/api/v1/org-changes", { params: { query: expect.objectContaining({ target_ref: "unit", offset: 1 }) } });
});
test("a failed timeline page never presents the first page as complete", async () => {
  fetchPage.mockResolvedValueOnce({ data: { items: [{ id: "one" }], total: 2 }, response: new Response(null, { status: 200 }) } as never).mockRejectedValueOnce(new Error("read failed"));
  await expect(scheduledUnitChangesQuery("unit").queryFn()).rejects.toThrow("read failed");
});

test("a premature empty timeline page refuses to publish an incomplete list", async () => {
  fetchPage.mockResolvedValueOnce({ data: { items: [{ id: "one" }], total: 2 }, response: new Response(null, { status: 200 }) }).mockResolvedValueOnce({ data: { items: [], total: 2 }, response: new Response(null, { status: 200 }) });
  await expect(scheduledUnitChangesQuery("unit").queryFn()).rejects.toThrow("incomplete");
});
