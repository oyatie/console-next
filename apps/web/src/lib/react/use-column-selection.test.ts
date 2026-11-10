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
    expect(state).toEqual({ sel: "emp-1", sel2: undefined, sort: "name", full: undefined });

    cols().selectRelated("unit-2");
    expect(state).toEqual({ sel: "emp-1", sel2: "unit-2", sort: "name", full: undefined });

    cols().select("emp-2");
    expect(state).toEqual({ sel: "emp-2", sel2: undefined, sort: "name", full: undefined });

    cols().closeRightmost();
    expect(state).toEqual({ sel: undefined, sel2: undefined, sort: "name", full: undefined });
  });
});


test.each([
  [{ full: "1" }, false],
  [{ sel: "emp-1", full: "1" }, true],
  [{ sel: "emp-1", full: 1 }, true],
  [{ sel: "emp-1", full: "0" }, false],
  [{ sel: "emp-1", full: "other" }, false],
])("full requires a selection and the URL flag: %j", (search, full) => {
  expect(columnSelection(search, vi.fn()).full).toBe(full);
});

test("expand and restore preserve selection; selection writes always drop full", () => {
  let state: Record<string, unknown> = { sel: "emp-1", sel2: "unit-1", sort: "name" };
  const navigate = vi.fn(({ search }: { search: (prev: typeof state) => typeof state }) => { state = search(state); });
  const cols = () => columnSelection(state, navigate);
  cols().expand();
  expect(state).toEqual({ sel: "emp-1", sel2: "unit-1", sort: "name", full: 1 });
  cols().restore();
  expect(state).toEqual({ sel: "emp-1", sel2: "unit-1", sort: "name", full: undefined });
  for (const write of [() => cols().select("emp-2"), () => cols().selectRelated("unit-2"), () => cols().closeRightmost()]) {
    cols().expand();
    expect(cols().full).toBe(true);
    write();
    expect(state.full).toBeUndefined();
  }
  cols().closeRightmost();
  cols().expand();
  expect(cols().full).toBe(false);
  expect(state.full).toBeUndefined();
  expect(navigate).toHaveBeenLastCalledWith({ search: expect.any(Function), replace: true, resetScroll: false });
});
