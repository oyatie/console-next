import { useState } from "react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { ORG_CHANGE_STATUS, actor, labeled } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { todayKst } from "../../../lib/pure/today";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { daysBetween } from "../../../ui/date/days";
import { EmptyState } from "../../../ui/empty-state";
import { Pager } from "../../../ui/pager";
import { Table } from "../../../ui/table";
import { CHANGE_VIEWS, CHANGES_PAGE, changesViewQuery, myChangesQuery, type ChangeView } from "../api";
import { awaitingRedraft, changeTitle } from "../present";
import { useChangeNames } from "./use-change-names";
import { useOrgRouted } from "./use-org-routed";
import css from "./org-change.module.css";

const route = getRouteApi("/app/org/changes");
const ALL_VIEWS = Object.keys(CHANGE_VIEWS) as ChangeView[];

/**
 * Org changes in saved views, each with the server's count. There is no text search: the API filters by
 * status, drafter and effective dates, and searching one loaded page would pretend to search them all (§9).
 */
export function OrgChanges() {
  const { view = "open", effective_from, effective_to } = route.useSearch();
  const range = { effective_from, effective_to };
  // decisions #26: the approval view exists only for a tenant that routes org changes.
  const routed = useOrgRouted();
  const VIEWS = ALL_VIEWS.filter((v) => routed || v !== "approval");
  // org-21 (#26): with approval off nothing is ever rejected, so the closed view reads as cancelled only.
  const word = (v: ChangeView) => (v === "closed" && !routed ? "cancelled" : v);
  const navigate = route.useNavigate();
  const [offset, setOffset] = useState(0);
  const counts = useQueries({ queries: VIEWS.map((v) => changesViewQuery(v, 0, 1, range)) });
  const list = useQuery({ ...changesViewQuery(view, offset, undefined, range), placeholderData: keepPreviousData });
  // My rejected changes awaiting a redraft are still in progress for me: the open view leads with them. A redraft
  // on this page settles its original too, so a newer page never shows both while my changes are re-read.
  const mine = useQuery(myChangesQuery(range));
  const redraft = awaitingRedraft(mine.data?.items ?? [], list.data?.items ?? []);
  const lead = view === "open" && offset === 0 ? redraft : [];
  const n = useChangeNames();
  const today = todayKst();
  const pick = (v: ChangeView) => {
    setOffset(0);
    void navigate({ search: (q) => ({ ...q, view: v === "open" ? undefined : v }), replace: true });
  };
  return (
    <div className="page">
      <div className="page__head">
        <Link to="/org" search={{}} className="btn btn--ghost">{t("org.title")}</Link>
        <h1 className="page__title">{t("orgChange.list.title")}</h1>
        {(effective_from || effective_to) && <Button variant="ghost" onClick={() => {
          setOffset(0);
          void navigate({ search: (q) => ({ ...q, effective_from: undefined, effective_to: undefined }), replace: true });
        }}>{t("asof.clearRange")}</Button>}
      </div>
      <div role="group" aria-label={t("orgChange.list.views")} className="tabs">
        {VIEWS.map((v, i) => (
          <ToggleButton key={v} pressed={v === view} onClick={() => pick(v)}>
            {t(`orgChange.list.view.${word(v)}`, { count: (counts[i]?.data?.total ?? 0) + (v === "open" ? redraft.length : 0) })}
          </ToggleButton>
        ))}
      </div>
      <section className="card">
        <QueryState
          q={list} layout="list"
          empty={(d) =>
            d.items.length || lead.length ? null : (
              <EmptyState
                title={t(`orgChange.list.empty.${word(view)}`)}
                reason={t("orgChange.list.empty.reason")}
                actions={<Link to="/org" search={{}} className="btn btn--primary">{t("orgChange.list.empty.action")}</Link>}
              />
            )
          }
        >
          {(d) => (
            <>
              <Table
                label={t("orgChange.list.title")}
                rows={[...lead, ...d.items]}
                rowId={(c) => c.id}
                columns={[
                  // Each change opens from its number: a real link, reachable by Tab like any other.
                  { header: t("orgChange.list.col.code"), cell: (c) => <Link to="/org/changes/$id" params={{ id: c.id }} className={`code ${css.nowrap}`}>{c.code}</Link>, fit: true },
                  { header: t("orgChange.list.col.change"), cell: (c) => changeTitle(c, n) },
                  { header: t("orgChange.list.col.status"), cell: (c) => { const s = labeled(ORG_CHANGE_STATUS, c.status); return <Chip tone={s.tone}>{s.label}</Chip>; }, fit: true },
                  {
                    header: t("orgChange.list.col.effective"),
                    fit: true,
                    cell: (c) => {
                      const days = daysBetween(today, c.effectiveDate);
                      const ahead = days > 0 && (c.status === "DRAFT" || c.status === "PRECHECKED" || c.status === "IN_APPROVAL" || c.status === "APPROVED");
                      return <span className={`num ${css.nowrap}`}>{fmtDate(c.effectiveDate)}{ahead && <> · {t("orgChange.rel.ahead", { days })}</>}</span>;
                    },
                  },
                  { header: t("orgChange.list.col.drafter"), cell: (c) => <span className={css.nowrap}>{actor(c.draftedByName)}</span>, fit: true, wide: true },
                  { header: t("orgChange.list.col.updated"), cell: (c) => <span className={`num ${css.nowrap}`}>{fmtDateTime(c.updatedAt)}</span>, fit: true, wide: true },
                ]}
              />
              <Pager offset={offset} limit={CHANGES_PAGE} total={d.total} onPage={setOffset} />
            </>
          )}
        </QueryState>
      </section>
    </div>
  );
}
