// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { useBulkRows } from "./use-bulk-rows";

vi.mock("react", () => ({ useMemo: (read: () => unknown) => read() }));
vi.mock("@tanstack/react-query", () => ({
  useQueries: ({ queries }: { queries: { enabled?: boolean; source?: string }[] }) =>
    queries.map(() => ({
      data: { items: [{ id: "person", name: "직원", status: "ACTIVE" }], total: 1 },
      isSuccess: false,
      isPending: false,
      isError: true,
      error: new TypeError("offline"),
      refetch: () => {},
    })),
  useQuery: () => ({
    data: { items: [] },
    isSuccess: true,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock("../../../reference/org/api", () => ({ unitsQuery: { source: "units" } }));
vi.mock("../api", () => ({ IDS_PER_READ: 1, NUMBERS_PER_READ: 1, byIdsQuery: () => ({ source: "ids" }), byNumbersQuery: () => ({}) }));

test("a failed background read preserves the picked people rather than resolving to zero rows", () => {
  const result = useBulkRows({ picked: new Map([["person", "직원"]]) }, null, {}, {});
  expect(result.ready).toBe(true);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.employee?.name).toBe("직원");
});
