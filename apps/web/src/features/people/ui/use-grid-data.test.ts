// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { useGridData } from "./use-grid-data";

vi.mock("@tanstack/react-query", () => ({ useQueries: () => [{ data: { sex: "MALE" }, isSuccess: false, isPending: false, error: new TypeError("offline"), refetch: () => {} }] }));
vi.mock("./use-bulk-rows", () => ({ useBulkRows: () => ({
  ready: true,
  rows: [{ employee: { id: "person", name: "직원" } }],
  q: { data: true, isPending: false, error: null, refetch: () => {} },
}) }));

test("cached fact values stay ready in the grid after a failed background read", () => {
  const result = useGridData(new Map([["person", "직원"]]), ["sex"]);
  expect(result.ready).toBe(true);
  expect(result.value(0, "sex")).toBe("MALE");
});
