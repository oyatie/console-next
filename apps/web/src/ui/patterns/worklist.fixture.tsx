// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button, Check } from "../button/button";
import { Segmented } from "../button/segmented";
import { ChangeRows } from "../change-rows/change-rows";
import { DeadlineStrip } from "../deadline-strip/deadline-strip";
import { DecisionPane } from "../decision-pane/decision-pane";
import { DueCell } from "../due-cell/due-cell";
import { KeyValue } from "../key-value/key-value";
import { SearchField } from "../search/search-field";
import { Sheet } from "../sheet/sheet";
import { SortControl } from "../sort-control/sort-control";
import { Table } from "../table";
import { Worklist } from "./worklist";

const ITEMS = [
  { id: "W-1", n: 1, days: -2, date: "2026-11-08", statutory: false },
  { id: "W-2", n: 2, days: 0, date: "2026-11-10", statutory: false },
  { id: "W-3", n: 3, days: 2, date: "2026-11-12", statutory: true },
] as const;

const READY: ReadState = { isPending: false, error: null, data: ITEMS, refetch() {} };

/** Synthetic content for the in-shell Worklist (`P1`) pattern review. */
export default function WorklistExample({ q = READY }: { q?: ReadState }) {
  const [view, setView] = useState<"all" | "overdue">("all");
  const [legalOnly, setLegalOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<string>("W-3");
  const [opinion, setOpinion] = useState("");
  const [sheet, setSheet] = useState(false);

  const visible = ITEMS.filter(item => {
    if (view === "overdue" && item.days >= 0) return false;
    if (legalOnly && !item.statutory) return false;
    if (query && !`${tg("sample.person", { n: item.n })} ${item.id}`.includes(query)) return false;
    return true;
  });

  const activeItem = ITEMS.find(item => item.id === selected);

  return (
    <Worklist
      q={q}
      head={{
        title: t("home.inbox.title"),
        titleId: "worklist-title",
        commands: {
          label: t("common.more"),
          items: [{ id: "columns", label: t("common.more"), onAction: () => setSheet(true) }],
        },
      }}
      views={
        <Segmented
          label={t("home.attention.label")}
          value={view}
          onChange={setView}
          items={[
            { id: "all", label: t("home.attention.all"), count: ITEMS.length },
            { id: "overdue", label: t("home.attention.overdue"), count: 1, tone: "danger" },
          ]}
        />
      }
      filters={
        <Check checked={legalOnly} onChange={setLegalOnly}>
          {t("uiWorklist.statutoryLane")}
        </Check>
      }
      find={
        <div data-list-find="">
          <SearchField label={t("home.inbox.title")} value={query} onChange={setQuery} />
        </div>
      }
      tools={
        <SortControl
          fields={[{ id: "due", label: t("home.inbox.column.due") }]}
          field="due"
          direction={sortDir}
          onChange={next => setSortDir(next.direction)}
        />
      }
      list={
        <Table
          label={t("home.inbox.title")}
          rows={[...visible]}
          rowId={row => row.id}
          selected={selected}
          onSelect={setSelected}
          columns={[
            { header: t("home.inbox.column.due"), fit: true, cell: row => <DueCell days={row.days} /> },
            { header: t("home.inbox.column.task"), cell: row => tg("sample.person", { n: row.n }) },
            { header: t("home.inbox.column.subject"), cell: row => row.id },
          ]}
        />
      }
      schedule={
        <DeadlineStrip
          monthLabel="11"
          days={[
            { date: "2026-11-08", dayLabel: "08", bucket: "over" },
            { date: "2026-11-10", dayLabel: "10", bucket: "today" },
            { date: "2026-11-12", dayLabel: "12", bucket: "upcoming" },
          ]}
          entries={ITEMS.map(item => ({
            id: item.id,
            shortLabel: item.id,
            fullLabel: tg("sample.person", { n: item.n }),
            lane: item.statutory ? "statutory" : "operational",
            date: item.date,
            tone: item.days < 0 ? "over" : item.days === 0 ? "today" : "upcoming",
          }))}
          selectedId={selected}
          onSelect={setSelected}
        />
      }
      record={
        activeItem
          ? {
              id: activeItem.id,
              label: t("home.inbox.record.title"),
              title: tg("sample.person", { n: activeItem.n }),
              meta: activeItem.id,
              openInTab: { href: "/inbox", label: activeItem.id },
              onClose: () => setSelected(""),
              footer: (
                <DecisionPane
                  key={activeItem.id}
                  opinion={opinion}
                  onOpinionChange={setOpinion}
                  onApprove={() => setSelected("")}
                  onReject={() => setSelected("")}
                />
              ),
              children: (
                <>
                  <KeyValue items={[{ key: "unit", label: tg("col.unit"), value: tg("sample.dept") }]} />
                  <ChangeRows
                    items={[
                      {
                        id: "c1",
                        subject: tg("sample.dept"),
                        before: tg("sample.position"),
                        after: tg("sample.team"),
                      },
                    ]}
                  />
                </>
              ),
            }
          : null
      }
      onSelect={setSelected}
      overlays={
        <Sheet
          open={sheet}
          title={t("home.inbox.title")}
          onClose={() => setSheet(false)}
          consequence={null}
          actions={<Button onClick={() => setSheet(false)}>{t("common.cancel")}</Button>}
        >
          {tg("sample.company")}
        </Sheet>
      }
    />
  );
}
