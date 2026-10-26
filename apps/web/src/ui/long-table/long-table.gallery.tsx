import { useMemo, useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { LongTable, type LongColumn } from "./long-table";
import { NO_SELECTION, type Selection } from "./selection";

export const order = 216;

type Person = { id: string; n: number };
const TOTAL = 3214;
const PAGE = 100;
const columns: LongColumn<Person>[] = [
  { id: "name", header: tg("col.name"), card: "title", cell: (r) => tg("sample.person", { n: r.n }), rowHeader: true, width: "2fr" },
  { id: "no", header: tg("form.number"), cell: (r) => <span className="code">{r.id}</span>, width: 120 },
  { id: "unit", header: tg("col.unit"), cell: (r) => (r.n % 7 === 0 ? tg("sample.teamLong") : tg("sample.team")), width: "3fr" },
  { id: "pos", header: tg("col.position"), cell: () => tg("sample.position") },
];

/**
 * 3,214 rows in pages of 100 (a stand-in for the caller's infinite query), compact rows, search on `/`, J/K row
 * keys, and the first page selected: selecting all 3,214 matches is offered disabled (one action takes up to 500).
 * Then the first page's placeholder and the empty table.
 */
export default function LongTables() {
  const [q, setQ] = useState("");
  const [pages, setPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sel, setSel] = useState<Selection>({ kind: "ids", ids: new Set(Array.from({ length: PAGE }, (_, i) => `HK-${String(i + 1).padStart(4, "0")}`)) });
  const matching = useMemo(() => Array.from({ length: TOTAL }, (_, i) => ({ id: `HK-${String(i + 1).padStart(4, "0")}`, n: i + 1 })).filter((r) => r.id.includes(q)), [q]);
  const rows = matching.slice(0, pages * PAGE);
  const loadMore = () => {
    setLoadingMore(true);
    setTimeout(() => (setPages((n) => n + 1), setLoadingMore(false)), 300);
  };
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiLongTable.name")}</h2>
      <LongTable
        label={t("uiLongTable.name")}
        caption={tg("table.many")}
        columns={columns}
        rows={rows}
        rowId={(r) => r.id}
        total={matching.length}
        hasMore={rows.length < matching.length}
        loadingMore={loadingMore}
        onLoadMore={loadMore}
        empty={tg("empty.reason")}
        find={{ label: tg("form.number"), onFind: (text) => (setQ(text.trim()), setPages(1), setSel(NO_SELECTION)) }}
        selection={sel}
        onSelectionChange={setSel}
        density="compact"
        rowKeys={{}}
        selectAllLimit={{ max: 500 }}
      />
      <LongTable label={tg("table.many")} columns={columns} rows={[]} rowId={(r) => r.id} hasMore={false} onLoadMore={() => {}} loading empty={null} />
      <LongTable label={tg("table.empty")} columns={columns} rows={[]} rowId={(r) => r.id} hasMore={false} onLoadMore={() => {}} empty={tg("empty.reason")} />
    </section>
  );
}
