import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, ChevronRight, Network } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { ORG_CHANGE_STATUS, actor, labeled } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { Button, Check, ToggleButton } from "../../../ui/button/button";
import { SectionHead } from "../../../ui/card/section-head";
import { Chip } from "../../../ui/chip";
import { DateField } from "../../../ui/date/date-field";
import { SelectField } from "../../../ui/select/select-field";
import { Table, type Column } from "../../../ui/table";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup } from "../../../lib/react/query-view";
import { changesQuery, entityBatchesQuery, me, orgBatchesQuery, structureQuery } from "../api";
import { feedRows, filterRows, scheduled, unitNames, type FeedRow } from "../domain/feed";
import { historyActions, historyKind, historyMode } from "../present";
import { UndoCell } from "./undo-cell";
import bulk from "./bulk.module.css";
import s from "./history.module.css";

const SOURCES = ["all", "org", "entity", "change"] as const;
type Source = (typeof SOURCES)[number];

/** S9 org chart history: recorded actions and actors, with undo only where the server permits it. */
export function HistoryPage() {
  const org = useQuery(orgBatchesQuery);
  const entity = useQuery(entityBatchesQuery);
  const changes = useQuery(changesQuery);
  const tree = useQuery(structureQuery);
  const [source, setSource] = useState<Source>("all");
  const [undoable, setUndoable] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [actorId, setActorId] = useState("");
  const reset = () => { setSource("all"); setUndoable(false); setFrom(""); setTo(""); setActorId(""); };
  const filtered = source !== "all" || undoable || from || to || actorId;
  const all = readGroup([org, entity, changes, tree]);
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
          const shown = filterRows(rows, { source, undoable, from, to, actorId });
          const actors = [...new Map(rows.flatMap(r => r.actor?.id ? [[r.actor.id, actor(r.actor.name)] as const] : [])).entries()];
          const filters = [source !== "all" && t(`orgHistory.filter.source.${source}`), undoable && t("orgHistory.filter.undoable"), from && fmtDate(from), to && fmtDate(to), actorId && actors.find(([id]) => id === actorId)?.[1]].filter(Boolean).join(" · ");
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
              <SectionHead level={2}>{t("orgHistory.filter.scope")}</SectionHead>
              <div className={s.filters}>
                <div role="group" aria-label={t("orgHistory.filter.source")} className="tabs">
                  {SOURCES.map((k) => <ToggleButton key={k} pressed={source === k} onClick={() => setSource(k)}>{t(`orgHistory.filter.source.${k}`)}</ToggleButton>)}
                </div>
                <Check checked={undoable} onChange={setUndoable}>{t("orgHistory.filter.undoable")}</Check>
                <DateField label={t("orgHistory.filter.from")} required={false} value={from} onChange={setFrom} today={today} max={to || today} />
                <DateField label={t("orgHistory.filter.to")} required={false} value={to} onChange={setTo} today={today} min={from || undefined} max={today} />
                <SelectField label={t("orgHistory.filter.actor")} required={false} value={actorId || "all"} onChange={id => setActorId(id === "all" ? "" : id)} placeholder={t("orgHistory.filter.actorAll")} options={[{ id: "all", label: t("orgHistory.filter.actorAll") }, ...actors.map(([id, label]) => ({ id, label }))]} />
                {filtered && <Button variant="ghost" onClick={reset}>{t("orgHistory.filter.reset")}</Button>}
              </div>
              {shown.length ? (
                <div className={bulk.scrollX} role="region" aria-label={t("orgHistory.title")}>
                  <Table label={t("orgHistory.title")} rows={shown} rowId={(r) => r.id} columns={columns()} />
                </div>
              ) : (
                <p className="muted" role="status">{rows.length ? t("orgHistory.emptyFiltered", { filters }) : t("orgHistory.empty")}</p>
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
  if (r.source === "entity") return r.units.length ? t("orgHistory.target.units", { names: r.units.slice(0, 2).join(", "), more: r.count - Math.min(2, r.units.length) }) : t("orgHistory.target.records", { count: r.count });
  if (r.source === "change") return r.change!.label;
  return r.units.length ? t("orgHistory.target.units", { names: r.units.slice(0, 2).join(", "), more: r.count - Math.min(2, r.units.length) }) : t("orgHistory.target.unitsGone", { count: r.count });
}

const columns = (): Column<FeedRow>[] => [
  { header: t("orgHistory.col.at"), fit: true, cell: (r) => <span className="num">{fmtDateTime(r.at)}</span> },
  { header: t("orgHistory.col.target"), cell: (r) => <strong>{targetText(r)}</strong> },
  {
    header: t("orgHistory.col.kind"),
    fit: true,
    cell: (r) => {
      if (r.source !== "change") return <Chip tone={r.kind === "UNDO" ? "neutral" : "info"}>{historyKind(r)}</Chip>;
      const l = labeled(ORG_CHANGE_STATUS, r.kind);
      return <Chip tone={l.tone}>{historyKind(r)}</Chip>;
    },
  },
  {
    header: t("orgHistory.col.who"),
    cell: (r) => (
      <span className={s.who}>
        <span>{actor(r.actor?.name)}</span>
        <span className="muted">{r.source === "change" ? t("orgHistory.how.change", { code: r.change!.code, date: fmtDate(r.change!.effectiveDate) }) : t("orgHistory.how.record", { mode: historyMode(r), actions: historyActions(r) })}</span>
      </span>
    ),
  },
  { header: t("orgHistory.col.undo"), cell: (r) => <UndoCell row={r} target={targetText(r)} /> },
];
