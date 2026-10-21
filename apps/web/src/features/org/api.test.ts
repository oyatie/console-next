import { expect, test, vi } from "vitest";
import { get } from "../../lib/query";
import { myChangesQuery } from "./api";

vi.mock("../../lib/query", () => ({ get: vi.fn(), read: vi.fn() }));

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
