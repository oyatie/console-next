import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonDayGrid, type Cell, type Range } from "./person-day-grid";

type R = { id: string; name: string; v: string[] };
const yoon: R = { id: "a", name: "윤하준", v: ["8", "", "x"] };
const hwang: R = { id: "b", name: "황정우", v: ["", "7:48-", ""] };
const han: R = { id: "c", name: "한지민", v: ["", "", ""] };

const html = (rows: R[], range: Range | null, editing: { value: string; cell: Cell } | null = null) =>
  renderToStaticMarkup(
    <PersonDayGrid<R>
      label="10월"
      total={86}
      rows={rows}
      rowKey={(r) => r.id}
      lead={[{ key: "n", header: "성명", cell: (r) => r.name, width: "name" }]}
      days={[1, 2, 3].map((d) => ({ key: String(d), label: d, sub: "", tone: d === 3 ? "holiday" : undefined }))}
      tail={[{ key: "t", header: "합계", cell: () => "8:00", width: "total" }]}
      cell={(r, d) => r.v[d]}
      look={(r, d) => (r.id === "b" && d === 1 ? "refused" : undefined)}
      describe={(r, d) => `${r.name} ${d + 1}일`}
      range={range}
      onRange={() => undefined}
      editing={editing}
      onEdit={() => undefined}
      onCommit={() => undefined}
      onKey={() => false}
      rowHeight={32}
    />,
  );
/** The `<tr>` of a person, by their name in the lead column. */
const rowOf = (h: string, name: string) => h.split("<tr").find((tr) => tr.includes(`>${name}</th>`)) ?? "";

test("a grid with the server's row count, row indexes, the selected range and the focused cell", () => {
  const h = html([yoon, hwang], { anchor: { row: "a", col: "1" }, focus: { row: "b", col: "2" } });
  expect(h).toContain('role="grid"');
  expect(h).toContain('aria-rowcount="87"');
  expect(h).toContain('aria-rowindex="3"');
  expect((h.match(/<td[^>]*aria-selected="true"/g) ?? []).length).toBe(4);
  expect(h).toContain('data-look="refused"');
  expect(h).toMatch(/aria-activedescendant="[^"]+-r1-c1"/);
  expect(h).toContain("합계");
});

// Regression (wrong-person entry): the open editor and the focus were drawn at a row index, so a re-sort, a live
// insert above or a removal while typing put the input, and then its value, in another person's row.
test("the open editor and the focus stay in their person's row through a reorder, an insert above and a filter", () => {
  const typing = { value: "9-18", cell: { row: "a", col: "2" } };
  const range = { anchor: typing.cell, focus: typing.cell };
  for (const rows of [[yoon, hwang], [hwang, yoon], [han, yoon, hwang], [hwang, han, yoon]]) {
    const h = html(rows, range, typing);
    expect(rowOf(h, "윤하준")).toContain('aria-label="윤하준 2일" value="9-18"');
    expect(rowOf(h, "윤하준")).toContain("data-focus");
    for (const other of ["황정우", "한지민"]) {
      expect(rowOf(h, other)).not.toContain("<input");
      expect(rowOf(h, other)).not.toContain("data-focus");
    }
  }
  // Filtered out or removed: nobody else gets the input, the focus or the active descendant.
  const gone = html([hwang, han], range, typing);
  expect(gone).not.toContain("<input");
  expect(gone).not.toContain("data-focus");
  expect(gone).not.toContain("aria-activedescendant");
});

test("nothing selected draws no focus and no selection", () => {
  const h = html([yoon, hwang], null);
  expect(h).not.toContain("data-focus");
  expect(h).not.toContain('aria-selected="true"');
});
