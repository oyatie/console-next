// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { decodeSheetText, readDelimited } from "./sheet-file";

test.each([
  { name: "empty", bytes: [], text: "", encoding: "utf-8" },
  { name: "ASCII", bytes: [0x30, 0x30, 0x31], text: "001", encoding: "utf-8" },
  { name: "UTF-8", bytes: [0xea, 0xb0, 0x80], text: "가", encoding: "utf-8" },
  { name: "UTF-8 BOM", bytes: [0xef, 0xbb, 0xbf, 0xea, 0xb0, 0x80], text: "가", encoding: "utf-8" },
  { name: "UTF-16LE BOM", bytes: [0xff, 0xfe, 0x00, 0xac, 0x09, 0x00, 0x31, 0x00], text: "가\t1", encoding: "utf-16le" },
  { name: "UTF-16BE BOM", bytes: [0xfe, 0xff, 0xac, 0x00], text: "가", encoding: "utf-16be" },
  { name: "CP949", bytes: [0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9], text: "가나다", encoding: "euc-kr" },
  { name: "UTF-8 supplementary character", bytes: [0xf0, 0x9f, 0x98, 0x80], text: "😀", encoding: "utf-8" },
])("decodes $name and reports the encoding", ({ bytes, text, encoding }) => {
  expect(decodeSheetText(new Uint8Array(bytes))).toEqual({ text, encoding });
});

test.each([
  { bytes: [0xef, 0xbb, 0xbf, 0xff] },
  { bytes: [0xff, 0xfe, 0x00] },
  { bytes: [0xfe, 0xff, 0xd8, 0x00] },
  { bytes: [0xb0] },
])("refuses malformed bytes instead of silently replacing text: $bytes", ({ bytes }) => {
  expect(decodeSheetText).toBeTypeOf("function");
  expect(() => decodeSheetText(new Uint8Array(bytes))).toThrow(TypeError);
});

test("decodes only the supplied byte view and passes BOM-free text to the parser", () => {
  const bytes = new Uint8Array([0, 0xef, 0xbb, 0xbf, 0x30, 0x31, 0x2c, 0x32, 0]);
  expect(readDelimited(decodeSheetText(bytes.subarray(1, -1)).text)).toEqual([["01", "2"]]);
  expect(decodeSheetText(new Uint8Array([0xb0, 0xa1]).buffer)).toEqual({ text: "가", encoding: "euc-kr" });
});

test("keeps the existing CSV/TSV detection, quoting, CRLF, empty cells and literal values", () => {
  expect(readDelimited('name,note\r\n"Kim, Min","two\r\nlines and ""quotes"""\r\n')).toEqual([
    ["name", "note"], ["Kim, Min", 'two\r\nlines and "quotes"'],
  ]);
  expect(readDelimited('number\tnote\n001\t"=1+1"\n\t\n')).toEqual([["number", "note"], ["001", "=1+1"], ["", ""]]);
  expect(readDelimited("")).toEqual([]);
});

test("an explicit delimiter preserves commas inside a TSV cell", () => {
  expect(readDelimited('"HR, payroll\tlead"\t"two\nlines"\r\n', { delimiter: "\t" })).toEqual([["HR, payroll\tlead", "two\nlines"]]);
  expect(readDelimited("HR, payroll", { delimiter: "\t" })).toEqual([["HR, payroll"]]);
  expect(readDelimited("HR,payroll\tlead", { delimiter: "," })).toEqual([["HR", "payroll\tlead"]]);
});

test("mixed appointment rows choose tabs outside quotes, then commas, once per record", () => {
  expect(readDelimited('001\tHR, payroll\n002,"HR\tlead\nPM",Kim\n003\t"HR\tlead"\tLee', { delimiter: "mixed" })).toEqual([
    ["001", "HR, payroll"], ["002", "HR\tlead\nPM", "Kim"], ["003", "HR\tlead", "Lee"],
  ]);
});
