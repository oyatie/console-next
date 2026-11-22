// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { useGridData } from "./use-grid-data";

const mockRows = [
  { employee: { id: "p2", name: "Employee 2" } },
  { employee: { id: "p1", name: "Employee 1" } },
];

vi.mock("@tanstack/react-query", () => ({
  useQueries: ({ queries }: { queries: unknown[] }) =>
    queries.length === 0
      ? []
      : [
          {
            data: {
              items: [
                { employee_id: "p1", sex: "FEMALE", birth_date: "••••-••-••", address: "Seoul" },
                { employee_id: "p2", sex: "MALE", birth_date: null, address: null },
              ],
              next_cursor: null,
            },
            isSuccess: false,
            isPending: false,
            error: new TypeError("offline"),
            refetch: () => {},
          },
        ],
}));
vi.mock("./use-bulk-rows", () => ({
  useBulkRows: () => ({
    ready: true,
    rows: mockRows,
    q: { data: true, isPending: false, error: null, refetch: () => {} },
  }),
}));

test("cached batch fact values stay ready in the grid and map by employee_id regardless of server order", () => {
  const result = useGridData(new Map([["p2", "Employee 2"], ["p1", "Employee 1"]]), ["sex", "birth_date", "address"]);
  expect(result.ready).toBe(true);
  expect(result.value(0, "sex")).toBe("MALE");
  expect(result.value(0, "birth_date")).toBeNull();
  expect(result.value(1, "sex")).toBe("FEMALE");
  expect(result.value(1, "birth_date")).toBe("••••-••-••");
  expect(result.value(1, "address")).toBe("Seoul");
});
