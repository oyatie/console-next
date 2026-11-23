// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { announce } from "../../../lib/react/announce";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { SheetGrid, type SheetGridColumn } from "../../../ui/sheet-grid/sheet-grid";
import { unitsQuery } from "../../../reference/org/api";
import { IDS_PER_READ, byIdsQuery } from "../api";
import { REGISTER_FACTS_BATCH, registerFactsBatchQuery } from "../api/record";
import { DEFAULT_COLUMNS, GRID_FIELDS, parseTsv, type Cell } from "../domain/grid";
import { pasteSkippedText } from "../present";
import { GridPage } from "./grid-page";
import { bulkSelection } from "./use-bulk-selection";
import s from "./grid-page.module.css";
import g from "./grid-table.gallery.module.css";

type GridRow = { id: string; number: string; name: string; current: readonly string[]; typed: readonly (string | undefined)[]; cells: readonly Cell[] };

const people = () => Array.from({ length: 2000 }, (_, i) => ({
  id: `emp-${i + 1}`, employee_number: String(i + 1).padStart(4, "0"), name: tg("sample.person", { n: i + 1 }),
  company: tg("sample.company"), job: tg("sample.position"), status: "ACTIVE", updated_at: "2026-10-20T00:00:00Z",
}));

function PageFixture() {
  const [client] = useState(() => {
    const query = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const employees = people();
    query.setQueryData(unitsQuery.queryKey, { items: [] });
    for (let offset = 0; offset < employees.length; offset += IDS_PER_READ) {
      const chunk = employees.slice(offset, offset + IDS_PER_READ);
      query.setQueryData(byIdsQuery(chunk.map((e) => e.id)).queryKey, { items: chunk, total: chunk.length });
    }
    for (let offset = 0; offset < employees.length; offset += REGISTER_FACTS_BATCH) {
      const chunk = employees.slice(offset, offset + REGISTER_FACTS_BATCH);
      query.setQueryData(registerFactsBatchQuery(chunk.map((e) => e.id)).queryKey, {
        items: chunk.map((e) => ({
          employee_id: e.id,
          updated_at: e.updated_at,
          sex: "MALE" as const,
          address: null,
          careers: null,
          exit_reason_code: null,
          exit_reason_label: null,
          register_note: null,
          birth_date: null,
        })),
        next_cursor: null,
      });
    }
    return query;
  });
  useEffect(() => {
    bulkSelection.set(new Map(people().map((employee) => [employee.id, employee.name])));
    return () => bulkSelection.set(new Map());
  }, []);
  return <QueryClientProvider client={client}><GridPage /></QueryClientProvider>;
}

function TableFixture({ readOnly }: { readOnly: boolean }) {
  const [rows, setRows] = useState<GridRow[]>(() => people().map((employee, i) => ({
    id: employee.id, number: employee.employee_number, name: employee.name,
    current: [t("bulkGrid.sex.MALE"), employee.name, employee.job], typed: [undefined, undefined, undefined],
    cells: [{ keep: true }, { keep: true }, i === 999 ? { bad: "server", code: "stale_record" } : { keep: true }],
  })));
  const [activeCell, setActiveCell] = useState<{ r: number; c: number } | null>(null);
  const [activeChanges, setActiveChanges] = useState(0);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const fields = GRID_FIELDS.filter((field) => DEFAULT_COLUMNS.includes(field.key));
  const columns: SheetGridColumn<GridRow>[] = fields.map((field, c) => ({
    key: field.key, header: t(`bulkGrid.field.${field.key}`), meta: t(`bulkGrid.tag.${field.cls}`),
    options: field.kind === "sex" ? [t("bulkGrid.sex.MALE"), t("bulkGrid.sex.FEMALE")] : [],
    cell: (row, r) => {
      const cell = row.cells[c]!;
      const value = row.typed[c] ?? row.current[c] ?? "";
      const invalid = "bad" in cell;
      return { label: t("bulkGrid.cell", { row: r + 1, field: t(`bulkGrid.field.${field.key}`) }), value, readOnly: readOnly && c === 1,
        changed: row.typed[c] !== undefined && "send" in cell, previous: row.current[c] || t("bulkGrid.blank"), invalid,
        error: invalid ? t("bulkGrid.err.server", { row: r + 1, field: t(`bulkGrid.field.${field.key}`), why: cell.bad === "server" ? cell.code : cell.bad }) : undefined,
        suggestion: readOnly && r === 1 && c === 1 ? { value: row.current[2]!, content: t("bulkGrid.err.suggest", { value: row.current[2]! }) } : undefined };
    },
  }));
  return <div className={`${s.page} ${g.table}`}>
    <header className={g.before}>
      <Button id="filter-empty" onClick={() => setRows([])}>{tg("empty.title")}</Button>
    </header>
    {pasteNotice && <Banner tone="warn" placement="page" title={pasteNotice} />}
    <div id="scroller" className={`${s.gridWrap} ${g.scroller}`} tabIndex={-1}>
      <SheetGrid rows={rows} rowKey={(row) => row.id} columns={columns}
        leading={[{ key: "number", header: t("bulkGrid.col.number"), cell: (row) => row.number, className: "num" }, { key: "name", header: t("bulkGrid.col.name"), cell: (row) => row.name }]}
        tail={{ header: t("bulkGrid.col.status"), cell: (row) => row.cells.some((cell) => "bad" in cell) ? { tone: "error", content: t("bulkGrid.status.error") } : { tone: "same", content: t("bulkGrid.status.same") } }}
        rowHeader={t("bulkGrid.col.row")} label={t("bulkGrid.title", { scope: t("bulkGrid.scopeAll") })} parsePaste={parseTsv}
        onPasteResult={(next) => { const notice = pasteSkippedText(next); setPasteNotice(notice); if (notice) announce(notice); }}
        activeCell={activeCell} onActiveChange={(at) => { setActiveCell(at); setActiveChanges((n) => n + 1); }}
        onCell={(changedRow, col, text) => setRows((current) => current.map((row) => row.id === changedRow.id ? { ...row, typed: row.typed.map((value, i) => i === col ? text : value) } : row))} />
    </div>
    <Button id="after" data-active={JSON.stringify(activeCell)} data-active-changes={activeChanges}>{t("bulkGrid.back")}</Button>
  </div>;
}

export default function SheetGridGallery() {
  const params = new URLSearchParams(location.search);
  const bounded = params.get("bounded") !== "false";
  return <section id="gallery-grid-table" className={g.gallery} data-isolated={params.has("grid")} data-bounded={bounded}>
    {params.get("grid") === "page" ? <PageFixture /> : <TableFixture readOnly={params.get("readonly") === "true"} />}
  </section>;
}
