import { expect, test } from "vitest";
import { parseOutline, pasteOps, pasteProblems } from "./paste";

const text = "생산부\n\t생산1팀\n\t생산2팀\n품질부\n  수입검사팀\n";

test("indentation becomes nesting, in row order, as one batch with refs", () => {
  const lines = parseOutline(text);
  expect(lines.map((l) => [l.name, l.depth])).toEqual([["생산부", 0], ["생산1팀", 1], ["생산2팀", 1], ["품질부", 0], ["수입검사팀", 1]]);
  const ops = pasteOps(lines, { workplace_id: "w1" });
  expect(ops[0]).toEqual({ op: "CREATE", ref: "p0", name: "생산부", workplace_id: "w1" });
  expect(ops[2]).toMatchObject({ parent_ref: "p0" });
  expect(ops[4]).toMatchObject({ parent_ref: "p3" });
});

test("a jump of two levels, a repeated sibling and an existing name are problems; cousins may share names", () => {
  const lines = parseOutline("A\n\t\t\tB\nC\nC\nD\n\tX\nE\n\tX");
  expect(pasteProblems(lines, new Set(["E"]))).toEqual([
    { line: 2, code: "tooDeep" },
    { line: 4, code: "duplicate" },
    { line: 7, code: "duplicate" },
  ]);
});

test("bullets and a second column are dropped", () => {
  expect(parseOutline("- 영업팀\t사업장").map((l) => l.name)).toEqual(["영업팀"]);
});
