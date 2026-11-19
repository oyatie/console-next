// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button, ToggleButton } from "../button/button";
import { LongTable } from "../long-table/long-table";
import { PageTabs } from "../tabs/page-tabs";
import { Sheet } from "../sheet/sheet";
import { ListRecord } from "./list-record";

const rows = Array.from({ length: 3 }, (_, i) => ({ id: `DEMO-${i + 1}`, n: i + 1 }));
const ready = { isPending: false, error: null, data: rows, refetch() {} };

/** Synthetic content for the in-shell pattern review. */
export default function ListRecordExample({ q = ready }: { q?: ReadState }) {
  const [record, setRecord] = useState<string>();
  const [related, setRelated] = useState(false);
  const [full, setFull] = useState(false);
  const [sheet, setSheet] = useState<string>();
  const [view, setView] = useState("current");
  const [findSlot, setFindSlot] = useState<HTMLDivElement | null>(null);
  const [find, setFind] = useState("");
  const [compact, setCompact] = useState(false);
  const filtered = rows.filter(row => `${tg("sample.person", { n: row.n })} ${row.id}`.includes(find));
  const range = t("roster.foot.range", { shown: filtered.length, total: rows.length });
  return <ListRecord q={q}
    head={{ title: t("roster.head.title"), titleId: "people-title", asOf: t("roster.head.today"),
      primary: { id: "register", label: t("people.register"), onAction: () => setSheet(t("people.register")) },
      commands: { label: t("common.more"), items: [{ id: "import", label: t("roster.head.import"), onAction: () => setSheet(t("roster.head.import")) }] },
    }}
    tabs={<PageTabs label={t("roster.head.title")} items={[{ id: "roster", label: t("roster.page.roster") }]} selected="roster" onSelect={() => {}} href={() => "/_review/patterns/list-record"} />}
    views={<div role="group" aria-label={t("roster.view.label")}>
      {(["current", "preHire"] as const).map(id => <ToggleButton key={id} pressed={view === id} onClick={() => setView(id)}>{t(`roster.view.${id}`)}</ToggleButton>)}
    </div>}
    find={<div ref={setFindSlot} />}
    filters={<Button onClick={() => setFind("")}>{t("people.filter.reset")}</Button>}
    tools={<ToggleButton pressed={compact} onClick={() => setCompact(!compact)}>{t("roster.density.compact")}</ToggleButton>}
    notes={<div role="note">{t("roster.scope.branches")}</div>}
    list={<LongTable label={t("people.table")} rows={filtered} rowId={row => row.id} total={filtered.length} hasMore={false} onLoadMore={() => {}} empty={tg("empty.title")}
      density={compact ? "compact" : "regular"} onRowAction={setRecord} findSlot={findSlot} find={{ label: t("roster.find"), onFind: setFind }}
      columns={[
        { id: "name", header: tg("col.name"), rowHeader: true, card: "title", cell: row => tg("sample.person", { n: row.n }) },
        { id: "number", header: tg("form.number"), card: "fact", cell: row => row.id },
      ]} />}
    record={record && { id: record, label: t("people.panel"), title: record, onClose: () => { setRecord(undefined); setRelated(false); },
      children: <Button onClick={() => setRelated(true)}>{t("roster.panel.unit")}</Button>,
    }}
    related={related && { id: "unit", label: t("roster.panel.unit"), title: tg("sample.dept"), onClose: () => setRelated(false), children: tg("sample.team") }}
    full={full} onFull={setFull}
    foot={<footer>{range}</footer>}
    facts={<output>{tg("col.name")}</output>}
    overlays={<Sheet open={Boolean(sheet)} title={sheet ?? ""} onClose={() => setSheet(undefined)} consequence={null}
      actions={<Button onClick={() => setSheet(undefined)}>{t("common.cancel")}</Button>}>{tg("sample.person", { n: 1 })}</Sheet>}
  />;
}
