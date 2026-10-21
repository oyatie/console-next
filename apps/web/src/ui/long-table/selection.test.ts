import { expect, test } from "vitest";
import { ALL_MATCHING, NO_SELECTION, applyKeys, selectionCount, shownKeys, toRequest } from "./selection";

const loaded = ["a", "b", "c"];

test("the header checkbox selects only the loaded rows, never every match", () => {
  const sel = applyKeys(NO_SELECTION, "all", loaded);
  expect(sel).toEqual({ kind: "ids", ids: new Set(loaded) });
  expect(selectionCount(sel, 3000)).toBe(3);
  expect(toRequest(sel)).toEqual({ ids: loaded });
});

test("all matching: unchecking a row excludes it, the count is the server total minus exclusions", () => {
  expect(shownKeys(ALL_MATCHING, loaded)).toBe("all");
  const sel = applyKeys(ALL_MATCHING, new Set(["a", "c"]), loaded);
  expect(sel).toEqual({ kind: "all", excluded: new Set(["b"]) });
  expect(shownKeys(sel, [...loaded, "d"])).toEqual(new Set(["a", "c", "d"]));
  expect(selectionCount(sel, 3000)).toBe(2999);
  expect(toRequest(sel)).toEqual({ all_matching: true, exclude_ids: ["b"] });
});

test("all matching: re-checking the header restores every match; clearing it clears everything", () => {
  const excluded = applyKeys(ALL_MATCHING, new Set(["a"]), loaded);
  expect(applyKeys(excluded, "all", loaded)).toEqual(ALL_MATCHING);
  expect(applyKeys(ALL_MATCHING, new Set(), loaded)).toEqual(NO_SELECTION);
});

test("explicit ids follow React Aria's set", () => {
  expect(applyKeys(NO_SELECTION, new Set(["b"]), loaded)).toEqual({ kind: "ids", ids: new Set(["b"]) });
});
