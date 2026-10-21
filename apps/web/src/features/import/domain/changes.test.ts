import { expect, test } from "vitest";
import { changedCells } from "./changes";

test("an update's cells and every deferred difference are listed; inserts and unchanged rows change no cell", () => {
  const rows = [
    { source_key: "a", sheet: "본사", row: 3, name: "김민준", outcome: "update", employee_number: "HJ-1", diff: [{ field: "position", from: "사원", to: "대리" }], deferred: [{ field: "org_unit", from: "인사팀", to: "생산팀", route: "lifecycle_transfer" }] },
    { source_key: "b", sheet: "본사", row: 4, name: "이서연", outcome: "insert", diff: [{ field: "job", to: "x" }] },
    { source_key: "c", sheet: "본사", row: 5, name: "박도윤", outcome: "unchanged" },
  ] as never;
  expect(changedCells(rows)).toEqual([
    { key: "a", number: "HJ-1", name: "김민준", field: "position", from: "사원", to: "대리" },
    { key: "a", number: "HJ-1", name: "김민준", field: "org_unit", from: "인사팀", to: "생산팀", route: "lifecycle_transfer" },
  ]);
});
