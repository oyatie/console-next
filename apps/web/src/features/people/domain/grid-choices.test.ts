import { expect, test } from "vitest";
import { narrow } from "./grid-choices";

// r3:records-17: typing narrows a choice column's options; nothing typed shows them all.
test("typed text narrows the options, spaces aside", () => {
  expect(narrow(["남", "여"], "")).toEqual(["남", "여"]);
  expect(narrow(["남", "여"], "남")).toEqual(["남"]);
  expect(narrow(["정규직", "계약직", "일용직"], "계 약")).toEqual(["계약직"]);
  expect(narrow(["남", "여"], "남자?")).toEqual([]);
});
