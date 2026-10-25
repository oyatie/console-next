import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { bootEn, bootKo } from "../packages/i18n/src/catalogs/boot";
import { en } from "../packages/i18n/src/catalogs/en";
import { ko } from "../packages/i18n/src/catalogs/ko";
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

test("production catalog ids and entity history literals do not leak gallery-only copy", () => {
  const appCopy = [bootKo, bootEn, ko, en].flatMap(Object.values);
  const source = new URL("../packages/i18n/src/", import.meta.url);
  const galleryCopy = readdirSync(source).filter((file) => /^gallery.*\.ts$/.test(file))
    .flatMap((file) => [...readFileSync(new URL(file, source), "utf8").matchAll(/^\s+"[^"]+": "(.+)",$/gm)].map((match) => match[1]!))
    .filter((text) => text.length >= 4 && !appCopy.some((app) => app.includes(text)));
  expect(galleryCopy.length).toBeGreaterThan(0);
  const presenter = readFileSync(new URL("../apps/web/src/features/entity/present.ts", import.meta.url), "utf8");
  expect(leakedCopy(JSON.stringify(Object.keys(ko)) + "\n" + presenter, galleryCopy)).toEqual([]);
  expect(leakedCopy(JSON.stringify(Object.keys(en)), galleryCopy)).toEqual([]);
});
