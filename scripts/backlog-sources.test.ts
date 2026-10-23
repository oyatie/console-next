// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
// @ts-expect-error: plain .mjs script, typed by its use here
import { markdownBlocks } from "./backlog-sources.mjs";

test("multiline comments cannot become backlog prose or headings; source line numbers survive", () => {
  expect(markdownBlocks("# Visible\n<!-- hidden\n# Hidden\nsecret\n-->\nActual requirement\n")).toEqual([
    { line: 6, endLine: 6, section: "Visible", summary: "Actual requirement" },
  ]);
});

test("inline and unclosed comments are omitted while visible requirements remain", () => {
  expect(markdownBlocks("Before <!-- hidden --> after\n\n<!-- unfinished\nhidden")).toEqual([
    { line: 1, endLine: 1, section: "", summary: "Before  after" },
  ]);
});

test("an illustrative open comment inside fenced code cannot hide later requirements", () => {
  expect(markdownBlocks("# Visible\n```html\n<!-- illustrative open comment\n```\nActual requirement\n")).toEqual([
    { line: 5, endLine: 5, section: "Visible", summary: "Actual requirement" },
  ]);
});

test.each([
  "Before <!<!-- nested -->-- hidden --> after",
  "Before <<!-- overlapping -->!-- hidden --> after",
])("stripping nested or overlapping comments cannot manufacture another opener: %s", (text) => {
  expect(markdownBlocks(text)).toEqual([
    { line: 1, endLine: 1, section: "", summary: "Before  after" },
  ]);
});
