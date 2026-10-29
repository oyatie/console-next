// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const manifest = read("../package.json");
const lock = read("../package-lock.json");
const ledger = read("./quality/dependency-verification.json");

test.each([
  ["typed-rest-client", "qs"],
  ["exceljs", "uuid"],
])("%s resolves its scoped %s override from the verified lock pin", (parent, child) => {
  const note = ledger[`package.json:overrides:${parent}:${child}`];
  expect(note).toBeDefined();
  expect(manifest.overrides?.[parent]?.[child]).toBe(note.requirement);
  expect(manifest.overrides?.[child]).toBeUndefined();
  const pin = lock.packages[`node_modules/${parent}/node_modules/${child}`] ?? lock.packages[`node_modules/${child}`];
  expect(pin.version).toBe(note.version);
  expect(pin.integrity).toMatch(/^sha512-/);
  const load = createRequire(require.resolve(`${parent}/package.json`));
  expect(load(`${child}/package.json`).version).toBe(note.version);
});

test("ExcelJS CommonJS writes and reads extended conditional formatting using UUID v4", async () => {
  const ExcelJS = require("exceljs") as typeof import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Override compatibility");
  sheet.addRows([[1], [2], [3]]);
  sheet.addConditionalFormatting({
    ref: "A1:A3",
    rules: [{ type: "dataBar", priority: 1, gradient: false, cfvo: [{ type: "min" }, { type: "max" }] }],
  });
  const bytes = await workbook.xlsx.writeBuffer();
  // A plain conditional format never calls uuid; the x14 extension must contain the generated v4 ID.
  const id = expect.stringMatching(/^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
  expect(sheet.model).toHaveProperty("conditionalFormattings.0.rules.0.x14Id", id);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  expect(restored.worksheets[0].getCell("A3").value).toBe(3);
  expect(restored.worksheets[0].model).toHaveProperty("conditionalFormattings.0.rules.0", expect.objectContaining({ type: "dataBar", gradient: false, x14Id: id }));
});

test("typed-rest-client CommonJS still encodes nested and repeated query parameters", () => {
  const { getUrl } = require("typed-rest-client/Util");
  const url = new URL(getUrl("items", "https://console.invalid/api/", {
    params: { filter: { name: "김 & 이" }, id: ["a/b", "c d"] },
  }));
  expect(url.pathname).toBe("/api/items");
  expect(url.searchParams.get("filter[name]")).toBe("김 & 이");
  expect(url.searchParams.getAll("id")).toEqual(["a/b", "c d"]);
});

test("typed-rest-client comma queries tolerate null array entries (GHSA-q8mj-m7cp-5q26)", () => {
  const { getUrl } = require("typed-rest-client/Util");
  const url = new URL(getUrl("https://console.invalid/items", undefined, {
    params: { id: [null, "b"] }, options: { arrayFormat: "comma" },
  }));
  expect(url.searchParams.get("id")).toBe(",b");
});

test("scoped qs resolves to at least 6.16.1", () => {
  const load = createRequire(require.resolve("typed-rest-client/package.json"));
  const [major, minor, patch] = load("qs/package.json").version.split(".").map(Number);
  expect(major > 6 || (major === 6 && (minor > 16 || (minor === 16 && patch >= 1)))).toBe(true);
});

test.each([false, true])("scoped qs comma queries tolerate non-callable toString with encodeValuesOnly=%s (GHSA-6pq8-jhm2-2vcw)", (encodeValuesOnly) => {
  const load = createRequire(require.resolve("typed-rest-client/package.json"));
  const qs = load("qs");
  const query = qs.stringify({ id: [{ toString: "x" }, "b"] }, { arrayFormat: "comma", encodeValuesOnly });
  expect(new URLSearchParams(query).get("id")).toBe("[object Object],b");
});

test("scoped qs preserves array limits (GHSA-x5fp-wj9c-mxmx)", () => {
  const load = createRequire(require.resolve("typed-rest-client/package.json"));
  const qs = load("qs");
  expect(() => qs.parse("a[]=1,2,3,4", { comma: true, arrayLimit: 3, throwOnLimitExceeded: true })).toThrow(RangeError);
});

test("scoped qs safely serializes parsed constructor keys (GHSA-4mjr-xmp4-gh2g)", () => {
  const load = createRequire(require.resolve("typed-rest-client/package.json"));
  const qs = load("qs");
  const parsed = qs.parse("x[constructor][isBuffer]=y", { plainObjects: true });
  expect(qs.stringify(parsed)).toBe("x%5Bconstructor%5D%5BisBuffer%5D=y");
});
