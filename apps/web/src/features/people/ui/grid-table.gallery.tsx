// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Button } from "../../../ui/button/button";
import { unitsQuery } from "../../../reference/org/api";
import { ROSTER_PAGE, rosterPageQuery } from "../api";
import { registerFactsQuery } from "../api/record";
import { DEFAULT_COLUMNS, GRID_FIELDS } from "../domain/grid";
import { GridTable, type GridRow } from "./grid-table";
import { GridPage } from "./grid-page";
import { bulkSelection } from "./use-bulk-selection";
import s from "./grid-page.module.css";
import g from "./grid-table.gallery.module.css";

const people = () => Array.from({ length: 2000 }, (_, i) => ({
  id: `emp-${i + 1}`, employee_number: String(i + 1).padStart(4, "0"), name: tg("sample.person", { n: i + 1 }),
  company: tg("sample.company"), job: tg("sample.position"), status: "ACTIVE", updated_at: "2026-10-20T00:00:00Z",
}));

function PageFixture() {
  const [client] = useState(() => {
    const query = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const employees = people();
    query.setQueryData(unitsQuery.queryKey, { items: [] });
    for (let offset = 0; offset < employees.length; offset += ROSTER_PAGE) {
      query.setQueryData(rosterPageQuery(offset).queryKey, { items: employees.slice(offset, offset + ROSTER_PAGE), total: employees.length });
    }
    for (const employee of employees) query.setQueryData(registerFactsQuery(employee.id).queryKey, { sex: "MALE", address: null });
    return query;
  });
  useEffect(() => {
    bulkSelection.set(new Map(people().map((employee) => [employee.id, employee.name])));
    return () => bulkSelection.set(new Map());
  }, []);
  return <QueryClientProvider client={client}><GridPage /></QueryClientProvider>;
}

function TableFixture() {
  const [rows, setRows] = useState<GridRow[]>(() => people().map((employee, i) => ({
    id: employee.id, number: employee.employee_number, name: employee.name,
    current: [t("bulkGrid.sex.MALE"), "", employee.job], typed: [undefined, undefined, undefined],
    cells: [{ keep: true }, { keep: true }, i === 999 ? { bad: "server", code: "stale_record" } : { keep: true }],
  })));
  const [activeCell, setActiveCell] = useState<{ r: number; c: number } | null>(null);
  const [activeChanges, setActiveChanges] = useState(0);
  return <div className={`${s.page} ${g.table}`}>
    <header className={g.before}>
      <Button id="filter-empty" onClick={() => setRows([])}>{tg("empty.title")}</Button>
    </header>
    <div id="scroller" className={`${s.gridWrap} ${g.scroller}`} tabIndex={-1}>
      <GridTable rows={rows} columns={GRID_FIELDS.filter((f) => DEFAULT_COLUMNS.includes(f.key))}
        label={t("bulkGrid.title", { scope: t("bulkGrid.scopeAll") })}
        activeCell={activeCell} onActiveChange={(at) => { setActiveCell(at); setActiveChanges((n) => n + 1); }}
        onCell={(id, col, text) => setRows((current) => current.map((row) => row.id === id ? { ...row, typed: row.typed.map((value, i) => i === col ? text : value) } : row))}
        statusOf={(row) => row.cells.some((cell) => "bad" in cell) ? { tone: "error", text: t("bulkGrid.status.error") } : { tone: "same", text: t("bulkGrid.status.same") }}
        fieldLabel={(f) => t(`bulkGrid.field.${f.key}`)} suggestionOf={() => undefined} />
    </div>
    <Button id="after" data-active={JSON.stringify(activeCell)} data-active-changes={activeChanges}>{t("bulkGrid.back")}</Button>
  </div>;
}

export default function GridTableGallery() {
  const params = new URLSearchParams(location.search);
  const bounded = params.get("bounded") !== "false";
  return <section id="gallery-grid-table" className={g.gallery} data-isolated={params.has("grid")} data-bounded={bounded}>
    {params.get("grid") === "page" ? <PageFixture /> : <TableFixture />}
  </section>;
}
