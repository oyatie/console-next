import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, ChevronRight, Network } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTimeShort } from "@console/i18n/format";
import { ORG_CHANGE_STATUS, labeled } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { Check, ToggleButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Table, type Column } from "../../../ui/table";
import { QueryState } from "../../../lib/react/query-state";
import { changesQuery, entityBatchesQuery, me, orgBatchesQuery, structureQuery } from "../api";
import { feedRows, scheduled, unitNames, type FeedRow } from "../domain/feed";
import { UndoCell } from "./undo-cell";
import s from "./history.module.css";

const SOURCES = ["all", "org", "entity", "change"] as const;
type Source = (typeof SOURCES)[number];

/** S9 org chart change history: every setup batch and governed change, newest first, each with its undo or why not. */
export function HistoryPage() {
  const org = useQuery(orgBatchesQuery);
  const entity = useQuery(entityBatchesQuery);
  const changes = useQuery(changesQuery);
  const tree = useQuery(structureQuery);
  const [source, setSource] = useState<Source>("all");
  const [undoable, setUndoable] = useState(false);
  const all = { isPending: org.isPending || entity.isPending || changes.isPending, error: org.error ?? entity.error ?? changes.error, data: org.data && entity.data && changes.data ? true : undefined, refetch: () => Promise.all([org.refetch(), entity.refetch(), changes.refetch()]) };
  const names = useMemo(() => unitNames(tree.data?.entities ?? []), [tree.data]);
  const today = todayKst();
  return (
    <div className="page">
      <header className={s.head}>
        <span className={s.crumb}>
          <Network size={14} aria-hidden />
          <Link to="/org" search={{}}>{t("orgHistory.crumb")}</Link>
          <ChevronRight size={14} aria-hidden /> {t("orgHistory.crumbHere")}
        </span>
        <h1 className="page__title">{t("orgHistory.title")}</h1>
      </header>
      <QueryState q={all}>
        {() => {
          const rows = feedRows({ org: org.data!.items, entity: entity.data!.items, changes: changes.data!.items, nameOf: (id) => names.get(id), me: me() });
          const shown = rows.filter((r) => (source === "all" || r.source === source) && (!undoable || "batchId" in r.undo));
          const next = scheduled(changes.data!.items, today);
          return (
            <>
              {next.length > 0 && (
                <div className={s.banner} role="status">
                  <CalendarClock size={16} aria-hidden />
                  <span className={s.grow}>{t("orgHistory.scheduled", { count: next.length, date: fmtDate(next[0]!.effectiveDate), label: next[0]!.target.label, more: next.length - 1 })}</span>
                  <Link to="/org/changes" search={{ view: "ready" }} className="btn">{t("orgHistory.scheduledOpen")}</Link>
                </div>
              )}
              <div className={s.filters}>
                <div role="group" aria-label={t("orgHistory.filter.source")} className="tabs">
                  {SOURCES.map((k) => <ToggleButton key={k} pressed={source === k} onClick={() => setSource(k)}>{t(`orgHistory.filter.source.${k}`)}</ToggleButton>)}
                </div>
                <Check checked={undoable} onChange={setUndoable}>{t("orgHistory.filter.undoable")}</Check>
              </div>
              {shown.length ? (
                <Table label={t("orgHistory.title")} rows={shown} rowId={(r) => r.id} columns={columns()} />
              ) : (
                <p className="muted" role="status">{rows.length ? t("orgHistory.emptyFiltered") : t("orgHistory.empty")}</p>
              )}
              <p className="muted">{t("orgHistory.foot", { count: rows.length })}</p>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}

/** What a row is about, in words: the units still standing, or how many there were. */
function targetText(r: FeedRow) {
  if (r.source === "entity") return t("orgHistory.target.records", { count: r.count });
  if (r.source === "change") return r.change!.label;
  return r.units.length ? t("orgHistory.target.units", { names: r.units.slice(0, 2).join(", "), more: r.count - Math.min(2, r.units.length) }) : t("orgHistory.target.unitsGone", { count: r.count });
}

const columns = (): Column<FeedRow>[] => [
  { header: t("orgHistory.col.at"), fit: true, cell: (r) => <span className="num">{fmtDateTimeShort(r.at)}</span> },
  { header: t("orgHistory.col.target"), cell: (r) => <strong>{targetText(r)}</strong> },
  {
    header: t("orgHistory.col.kind"),
    fit: true,
    cell: (r) => {
      if (r.source !== "change") return <Chip tone={r.kind === "UNDO" ? "neutral" : "info"}>{t(`orgHistory.kind.${r.kind as "APPLY" | "UNDO"}`)}</Chip>;
      const l = labeled(ORG_CHANGE_STATUS, r.kind);
      return <Chip tone={l.tone}>{l.label}</Chip>;
    },
  },
  {
    header: t("orgHistory.col.who"),
    cell: (r) => (
      <span className={s.who}>
        <span>{r.actor ? (r.actor.mine ? t("orgHistory.who.me") : (r.actor.name ?? t("orgHistory.who.other"))) : t("orgHistory.who.unknown")}</span>
        <span className="muted">{r.source === "change" ? t("orgHistory.how.change", { code: r.change!.code, date: fmtDate(r.change!.effectiveDate) }) : t(`orgHistory.how.${r.source}`)}</span>
      </span>
    ),
  },
  { header: t("orgHistory.col.undo"), cell: (r) => <UndoCell row={r} target={targetText(r)} /> },
];
