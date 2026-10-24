// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { GridTable, type GridRow } from "./grid-table";
import { DEFAULT_COLUMNS, GRID_FIELDS } from "../domain/grid";

beforeAll(() => loadCatalog("ko"));

test("component test at 2,000 rows: rendered row elements <= visible + overscan", () => {
  const rows: GridRow[] = Array.from({ length: 2000 }, (_, i) => ({
    id: `emp-${i}`, number: String(i), name: "", current: [], typed: [],
    cells: DEFAULT_COLUMNS.map(() => ({ keep: true })),
  }));
  const visible = 25, overscan = 10;
  const markup = renderToStaticMarkup(<GridTable rows={rows} columns={GRID_FIELDS.filter((f) => DEFAULT_COLUMNS.includes(f.key))}
    label="People grid" visibleRows={visible} overscan={overscan}
    onCell={() => undefined} statusOf={() => ({ tone: "same", text: "" })}
    fieldLabel={(f) => f.key} suggestionOf={() => undefined} />);
  const rendered = (markup.match(/role="row"/g) ?? []).length - 1;
  expect(rendered).toBe(visible + overscan);
  expect(markup).toContain('aria-rowcount="2001"');
  expect(markup).not.toContain('aria-rowindex="2001"');
});
