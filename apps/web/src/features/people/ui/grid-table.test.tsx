import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { GridTable, type GridRow } from "./grid-table";
import type { GridField } from "../domain/grid";

beforeAll(() => loadCatalog("en"));

const columns: readonly GridField[] = [
  { key: "sex", kind: "sex", cls: "now" },
  { key: "address", kind: "address", cls: "now" },
  { key: "job", kind: "text", cls: "now" },
];

const rows2000: readonly GridRow[] = Array.from({ length: 2000 }, (_, i) => ({
  id: `emp-${i + 1}`,
  number: String(i + 1).padStart(4, "0"),
  name: `Person ${i + 1}`,
  current: ["MALE", "Seoul", "Developer"],
  typed: [undefined, undefined, undefined],
  cells: [{ keep: true }, { keep: true }, { keep: true }],
}));

test("component test at 2,000 rows: rendered row elements <= visible + overscan", () => {
  const visible = 25;
  const overscan = 10;
  const markup = renderToStaticMarkup(
    <GridTable
      rows={rows2000}
      columns={columns}
      label="직원 정보 그리드"
      onCell={() => undefined}
      statusOf={() => ({ tone: "same", text: "동일" })}
      fieldLabel={(f) => f.key}
      suggestionOf={() => undefined}
    />,
  );

  const allRows = markup.match(/role="row"/g) ?? [];
  const dataRowsCount = allRows.length - 1; // exclude header row
  expect(dataRowsCount).toBeLessThanOrEqual(visible + overscan);
});

test("keyboard navigation reaches row 2000", () => {
  let activeAt: { r: number; c: number } | null = { r: 0, c: 0 };
  let capturedKeyDown!: (e: { key: string; ctrlKey?: boolean; preventDefault: () => void }) => void;

  function KeyCapture(props: Parameters<typeof GridTable>[0]) {
    const vdom = GridTable(props);
    capturedKeyDown = vdom.props.onKeyDown;
    return vdom;
  }

  const initialMarkup = renderToStaticMarkup(
    <KeyCapture
      rows={rows2000}
      columns={columns}
      label="직원 정보 그리드"
      onCell={() => undefined}
      statusOf={() => ({ tone: "same", text: "동일" })}
      fieldLabel={(f) => f.key}
      suggestionOf={() => undefined}
      activeCell={activeAt}
      onActiveChange={(at) => {
        activeAt = at;
      }}
    />,
  );

  expect(initialMarkup).toContain(">Person 1<");
  expect(initialMarkup).not.toContain(">Person 2000<");
  expect(initialMarkup).toContain('id="grid-0-0"');
  expect(initialMarkup).not.toContain('id="grid-1999-0"');

  // Trigger keyboard navigation to the end (Ctrl+End on grid)
  expect(capturedKeyDown).toBeDefined();
  capturedKeyDown({
    key: "End",
    ctrlKey: true,
    preventDefault: () => undefined,
  });

  // Verify keyboard navigation moved active cell to row 2000 (0-indexed 1999)
  expect(activeAt).toEqual({ r: 1999, c: 2 });

  // Re-render with active cell at row 2000
  const endMarkup = renderToStaticMarkup(
    <GridTable
      rows={rows2000}
      columns={columns}
      label="직원 정보 그리드"
      onCell={() => undefined}
      statusOf={() => ({ tone: "same", text: "동일" })}
      fieldLabel={(f) => f.key}
      suggestionOf={() => undefined}
      activeCell={activeAt}
    />,
  );

  expect(endMarkup).toContain(">Person 2000<");
  expect(endMarkup).toContain('id="grid-1999-0"');
  expect(endMarkup).not.toContain(">Person 1<");
  expect(endMarkup).not.toContain('id="grid-0-0"');
  const allRows = endMarkup.match(/role="row"/g) ?? [];
  const dataRowsCount = allRows.length - 1;
  expect(dataRowsCount).toBeLessThanOrEqual(25 + 10);
});

test("keyboard navigation moves row by row and page by page", () => {
  let activeAt: { r: number; c: number } | null = { r: 0, c: 0 };
  let capturedKeyDown!: (e: { key: string; ctrlKey?: boolean; preventDefault: () => void }) => void;

  function KeyCapture(props: Parameters<typeof GridTable>[0]) {
    const vdom = GridTable(props);
    capturedKeyDown = vdom.props.onKeyDown;
    return vdom;
  }

  const renderGrid = (active: { r: number; c: number } | null) =>
    renderToStaticMarkup(
      <KeyCapture
        rows={rows2000}
        columns={columns}
        label="직원 정보 그리드"
        onCell={() => undefined}
        statusOf={() => ({ tone: "same", text: "동일" })}
        fieldLabel={(f) => f.key}
        suggestionOf={() => undefined}
        activeCell={active}
        onActiveChange={(at) => {
          activeAt = at;
        }}
        visibleRows={25}
      />,
    );

  renderGrid(activeAt);
  capturedKeyDown({ key: "ArrowDown", preventDefault: () => undefined });
  expect(activeAt).toEqual({ r: 1, c: 0 });

  renderGrid(activeAt);
  capturedKeyDown({ key: "PageDown", preventDefault: () => undefined });
  expect(activeAt).toEqual({ r: 26, c: 0 });

  renderGrid(activeAt);
  capturedKeyDown({ key: "PageUp", preventDefault: () => undefined });
  expect(activeAt).toEqual({ r: 1, c: 0 });

  renderGrid(activeAt);
  capturedKeyDown({ key: "End", ctrlKey: true, preventDefault: () => undefined });
  expect(activeAt).toEqual({ r: 1999, c: 2 });

  renderGrid(activeAt);
  capturedKeyDown({ key: "Home", ctrlKey: true, preventDefault: () => undefined });
  expect(activeAt).toEqual({ r: 0, c: 0 });
});
