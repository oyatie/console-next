import { expect, test } from "vitest";
import { leakedCopy } from "./bundle-copy.mjs";

test("identifiers from spreadsheet libraries do not count as gallery copy", () => {
  expect(leakedCopy("class Table { getTables() { return this.extraFieldsLength; } }", ["Tables", "Fields"])).toEqual([]);
});

test("quoted, escaped and template gallery copy remains forbidden inside longer strings", () => {
  expect(leakedCopy('const copy = { a: "Gallery \\u0054ables", b: `Fields demo`, c: \'Gallery only\' };', ["Tables", "Fields", "Gallery only"])).toEqual(["Tables", "Fields", "Gallery only"]);
});

test("regex quotes cannot hide a later literal, and interpolated template text is checked", () => {
  expect(leakedCopy('const pattern = /["\\\\]/; const copy = `Gallery ${name} Fields`;', ["Gallery", "Fields"])).toEqual(["Gallery", "Fields"]);
});
