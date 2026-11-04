// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test, vi } from "vitest";
import { columnSelection } from "./use-column-selection";

describe("columnSelection", () => {
  test("reads sel and sel2, clears sel2 when sel changes, and closes rightmost first", () => {
    let state: Record<string, unknown> = { sel: "emp-1", sel2: "unit-1", sort: "name" };
    const navigate = vi.fn(({ search }: { search: (prev: Record<string, unknown>) => Record<string, unknown> }) => {
      state = search(state);
    });

    const cols = () => columnSelection(state, navigate);
    expect(cols().sel).toBe("emp-1");
    expect(cols().sel2).toBe("unit-1");

    cols().closeRightmost();
    expect(state).toEqual({ sel: "emp-1", sel2: undefined, sort: "name" });

    cols().selectRelated("unit-2");
    expect(state).toEqual({ sel: "emp-1", sel2: "unit-2", sort: "name" });

    cols().select("emp-2");
    expect(state).toEqual({ sel: "emp-2", sel2: undefined, sort: "name" });

    cols().closeRightmost();
    expect(state).toEqual({ sel: undefined, sel2: undefined, sort: "name" });
  });
});
