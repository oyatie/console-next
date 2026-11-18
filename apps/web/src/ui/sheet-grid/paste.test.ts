// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { pasteBlock } from "./paste";

const rows = ["a", "b"];
const cells: Record<string, { readOnly?: boolean; keepOnPaste?: boolean }> = { "a0": {}, "a1": { keepOnPaste: true }, "b0": { readOnly: true }, "b1": {} };
const paste = (block: string[][], r: number, c: number) => {
  const written: string[] = [];
  const result = pasteBlock(block, r, c, rows, (row, _r, col) => cells[`${row}${col}`], (row, col, v) => written.push(`${row}${col}=${v}`));
  return { result, written };
};

test("a pasted block leaves a kept cell and writes the rest", () => {
  expect(paste([["x", "y"]], 0, 0)).toEqual({ result: { applied: 1, readOnly: 0, outside: 0, kept: 1 }, written: ["a0=x"] });
});

test("a one-cell paste still changes a kept cell", () => {
  expect(paste([["y"]], 0, 1)).toEqual({ result: { applied: 1, readOnly: 0, outside: 0, kept: 0 }, written: ["a1=y"] });
});

test("read-only and outside cells are counted, blanks are ignored", () => {
  expect(paste([["", "z"], ["r", "w"], ["o", ""]], 0, 0).result).toEqual({ applied: 1, readOnly: 1, outside: 1, kept: 1 });
});
