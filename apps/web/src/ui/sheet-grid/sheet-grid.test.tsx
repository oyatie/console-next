// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SheetGrid } from "./sheet-grid";

test("2,000 rows render only the visible window with absolute ARIA coordinates", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: `emp-${i}`, value: String(i) }));
  const visible = 25, overscan = 10;
  const markup = renderToStaticMarkup(<SheetGrid rows={rows} rowKey={(row) => row.id}
    columns={[{ key: "value", header: "Value", cell: (row, r) => ({ label: `Row ${r + 1}`, value: row.value }) }]}
    leading={[{ key: "number", header: "Number", cell: (row) => row.id }, { key: "name", header: "Name", cell: () => "" }]}
    tail={{ header: "Status", cell: () => ({ tone: "same", content: "" }) }} rowHeader="#" label="People grid"
    visibleRows={visible} overscan={overscan} onCell={() => undefined} parsePaste={() => []} />);
  const rendered = (markup.match(/role="row"/g) ?? []).length - 1;
  expect(rendered).toBe(visible + overscan);
  expect(markup).toContain('aria-rowcount="2001"');
  expect(markup).toContain('aria-colindex="4"');
  expect(markup).not.toContain('aria-rowindex="2001"');
});
