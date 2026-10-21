import { expect, test } from "vitest";
import { at, indexOf, moveRange, rectIn, rectSize, spanIn } from "./range";

const cols = ["d1", "d2", "d3", "d4"];
const axes = (rows: string[]) => ({ rows, cols });

test("a range moves, extends with shift and stays inside the grid, by keys", () => {
  const a = axes(["a", "b", "c", "d", "e"]);
  const start = at("c", "d2");
  expect(moveRange(start, "ArrowDown", false, a)).toEqual(at("d", "d2"));
  const wide = moveRange(moveRange(start, "ArrowRight", true, a)!, "ArrowDown", true, a)!;
  expect(wide).toEqual({ anchor: { row: "c", col: "d2" }, focus: { row: "d", col: "d3" } });
  expect(rectSize(rectIn(wide, a))).toEqual({ people: 2, days: 2, cells: 4 });
  expect(moveRange(start, "PageDown", false, a)!.focus).toEqual({ row: "e", col: "d2" });
  expect(moveRange(start, "Home", false, a)!.focus.col).toBe("d1");
  expect(moveRange(start, "x", false, a)).toBeNull();
});

// Regression (wrong-person entry): the selection and the cell being typed into were row indexes, so a re-sort, a
// filter, a live insert above or a removal moved them onto another person's row.
test("the focused cell stays on its person through a reorder, an insert above, a filter and a removal", () => {
  const typing = at("a", "d2");
  expect(indexOf(typing.focus, axes(["a", "b"]))).toEqual({ r: 0, c: 1 });
  expect(indexOf(typing.focus, axes(["b", "a"]))).toEqual({ r: 1, c: 1 }); // re-sorted
  expect(indexOf(typing.focus, axes(["new", "a", "b"]))).toEqual({ r: 1, c: 1 }); // a live insert above
  expect(indexOf(typing.focus, axes(["b"]))).toBeNull(); // filtered out or removed: nobody else is focused
  expect(rectIn(typing, axes(["b"]))).toBeNull();
  expect(rectSize(rectIn(typing, axes(["b"])))).toEqual({ people: 0, days: 0, cells: 0 });
});

test("a focus no longer shown starts again from the first cell; shift never extends from a missing anchor", () => {
  const gone = at("a", "d2");
  expect(moveRange(gone, "ArrowDown", false, axes(["b", "c"]))).toEqual(at("c", "d1"));
  expect(moveRange(gone, "ArrowRight", true, axes(["b", "c"]))).toEqual(at("b", "d2"));
  expect(moveRange(null, "ArrowRight", false, axes([]))).toBeNull();
});

test("the people a multi-row range covers change with an insert between its corners, not with one after", () => {
  const range = { anchor: { row: "a", col: "d1" }, focus: { row: "c", col: "d1" } };
  const before = spanIn(range, axes(["a", "b", "c"]));
  expect(spanIn(range, axes(["a", "b", "c", "d"]))).toBe(before); // the next page loaded below
  expect(spanIn(range, axes(["a", "x", "b", "c"]))).not.toBe(before); // someone new between the corners
  expect(spanIn(range, axes(["c", "b", "a"]))).toBe(["c", "b", "a"].join("\n")); // reversed: the span is redrawn
});
