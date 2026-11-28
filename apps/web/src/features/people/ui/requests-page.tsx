import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { ReadReference } from "../../../lib/react/read-reference";
import { QueryState } from "../../../lib/react/query-state";
import { authzApplies, authzQuery } from "../../../reference/authz/api";
import { useCan } from "../../../reference/authz/ui/use-can";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Count } from "../../../ui/count/count";
import { EmptyState } from "../../../ui/empty-state";
import { Pager } from "../../../ui/pager";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { WorklistSegmentBar } from "../../../ui/patterns/worklist-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table, type Column } from "../../../ui/table";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { changeRequestCountsQuery, mySub, REQUEST_PAGE, requestsQuery, selectedRequestQuery, type ChangeRequest, type Lane, type RequestStatus } from "../api";
import { RequestPanel, RequestPanelBody } from "./request-panel";
import { kindText, reasonText, statusOf, subjectText } from "../present";
import s from "./requests.module.css";

const route = getRouteApi("/app/people/requests");
const LANES: readonly Lane[] = ["all", "me", "role"];
const STATUSES: readonly (RequestStatus | undefined)[] = ["OPEN", "APPLIED", "DECLINED", "WITHDRAWN", undefined];

/**
 * Change requests (BW-17). HR (org-wide manage) works the organization's requests by lane, named to me or
 * open to any HR person, and applies or declines each with a reason; anyone else sees the requests they filed and may
 * withdraw an open one. The selected request opens beside the list.
 */
export function RequestsPage() {
  const { lane = "all", status = "OPEN", sel, page = 0 } = route.useSearch();
  const navigate = route.useNavigate();
  const can = useCan();
  const authz = useQuery({ ...authzQuery, enabled: authzApplies() });
  const hr = can("employee_directory_manage", "all");
  const set = (patch: { lane?: Lane; status?: RequestStatus | "ALL"; sel?: string; page?: number }) =>
    void navigate({ search: (x) => ({ ...x, page: undefined, ...patch }), replace: true });
  const select = (nextSel?: string) => void navigate({ search: (x) => ({ ...x, sel: nextSel }), replace: true });
  const active = hr ? lane : "all";
  const filtered = active !== "all" || status !== "ALL";
  const filters = [t(hr ? `requests.lane.${active}` : "requests.mine"), status !== "ALL" && t(`requests.status.${status}`)].filter(Boolean).join(" · ");
  const list = useQuery({ ...requestsQuery({ lane: active, mine: !hr, status: status === "ALL" ? undefined : status, offset: page * REQUEST_PAGE }), enabled: !authz.isLoading });
  const counts = useQuery({ ...changeRequestCountsQuery, enabled: !authz.isLoading && hr });
  const makeColumns = (compact: boolean): Column<ChangeRequest>[] => [
    { header: t("requests.col.kind"), cell: (r) => kindText(r.kind), fit: true, card: compact ? "fact" : undefined },
    { header: t("requests.col.subject"), cell: (r) => subjectText(r), wide: compact ? undefined : true, card: compact ? "title" : undefined },
    { header: t("requests.col.reason"), cell: (r) => reasonText(r.reason_code), wide: true, card: compact ? "omit" : undefined },
    {
      header: t("requests.col.at"),
      cell: (r) => (
        <>
          {compact ? (
            <time className={`num ${s.nowrap}`} dateTime={r.created_at}>{fmtDateTime(r.created_at)}</time>
          ) : (
            <span className="num">{fmtDateTime(r.created_at)}</span>
          )}{" "}
          {r.requested_by === mySub() && <Chip>{t("requests.mine")}</Chip>}
        </>
      ),
      fit: true,
      wide: compact ? true : undefined,
      card: compact ? "omit" : undefined,
    },
    { header: t("requests.col.status"), cell: (r) => <Chip className={compact ? s.nowrap : undefined} tone={statusOf(r.status).tone}>{statusOf(r.status).label}</Chip>, fit: true, card: compact ? "status" : undefined },
    {
      header: t("requests.col.open"),
      cell: (r) => (
        <Button
          size={compact ? "sm" : undefined}
          variant={compact ? "secondary" : "ghost"}
          onClick={compact ? (e) => { e.stopPropagation(); select(r.id); } : () => select(r.id)}
        >
          {t("requests.open")}
        </Button>
      ),
      fit: true,
      card: compact ? "action" : undefined,
    },
  ];
  const listReady = !authz.isLoading && !!list.data && !list.isPlaceholderData && !list.isError;
  const onPage = listReady ? list.data?.items.find(r => r.id === sel) : undefined;
  const offPage = Boolean(sel && listReady && !onPage);
  const exact = useQuery({ ...selectedRequestQuery(sel), enabled: offPage, retry: false });
  const selected = onPage ?? (offPage && !exact.isError && !exact.isPlaceholderData ? exact.data?.items.find(r => r.id === sel) : undefined);
  const selectionState = offPage && !selected && (
    <QueryState q={exact.error ? { ...exact, data: undefined } : exact} layout="form" compact
      denied={<EmptyState alert compact title={t("common.denied.panel")} reason={t("requests.selection.unavailable")} meta={<ReadReference error={exact.error} />} />}>
      {() => <EmptyState alert compact title={t("common.read.notFound.title")} reason={t("requests.selection.unavailable")} />}
    </QueryState>
  );
  const [decided, setDecided] = useState<ChangeRequest | null>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);

  const emptyNode = (
    <EmptyState
      title={t("requests.none.title")}
      reason={filtered ? t("requests.none.filtered", { filters }) : t(hr ? "requests.none.hr" : "requests.none.mine")}
      actions={filtered && <Button onClick={() => set({ lane: "all", status: "ALL", sel: undefined })}>{t("requests.filters.reset")}</Button>}
    />
  );

  const renderBaseline = () => (
    <div className="page">
      <div className="page__head">
        <h1 className="page__title">{t("requests.title")}</h1>
      </div>
      {decided && <Receipt state="recorded" message={t(`requests.done.${decided.status}`, { kind: kindText(decided.kind) })} />}
      <div className={s.layout}>
        <section className="card" aria-labelledby="rq-list">
          <div className="toolbar">
            <h2 id="rq-list" className="toolbar__title">{t("requests.list")}</h2>
          </div>
          {authz.isLoading ? <QueryState q={authz}>{() => null}</QueryState> : <>
            {hr && <div className="tabs" role="group" aria-label={t("requests.lanes")}>
              {LANES.map((l) => (
                <ToggleButton key={l} pressed={active === l} onClick={() => set({ lane: l })}>
                  {t(`requests.lane.${l}`)} <Count n={counts.data?.[l]} />
                </ToggleButton>
              ))}
            </div>}
            <div className="tabs" role="group" aria-label={t("requests.statuses")}>
              {STATUSES.map((x) => (
                <ToggleButton key={x ?? "ALL"} pressed={(status === "ALL" ? undefined : status) === x} onClick={() => set({ status: x ?? "ALL" })}>
                  {t(`requests.status.${x ?? "ALL"}`)}
                </ToggleButton>
              ))}
            </div>
            <QueryState q={list} empty={(d) => (d.items.length ? null : emptyNode)}>
              {(d) => (
                <>
                  <Table label={t("requests.list")} rows={d.items} rowId={(r) => r.id} columns={makeColumns(false)} selected={sel} onSelect={select} />
                  <Pager offset={d.offset} limit={REQUEST_PAGE} total={d.total} onPage={(o) => set({ page: Math.floor(o / REQUEST_PAGE), sel })} />
                </>
              )}
            </QueryState>
          </>}
        </section>
        {selected ? <RequestPanel r={selected} hr={hr} onClose={() => select(undefined)} onDecided={(out) => { setDecided(out); select(undefined); }} /> :
          selectionState && <aside className="card panel" aria-label={t("requests.panel")}>
            <div className="panel__head"><h2 className="panel__title">{t("requests.panel")}</h2>
              <Button variant="ghost" onClick={() => select(undefined)}>{t("requests.panel.close")}</Button></div>
            {selectionState}
          </aside>}
      </div>
    </div>
  );

  const listQ = authz.isLoading ? { ...list, isPending: true, isLoading: true, data: undefined, error: null } : list;
  const hasPager = Boolean(list.data && (list.data.offset > 0 || list.data.offset + REQUEST_PAGE < list.data.total));

  return (
    <ExperienceSwitch baseline={renderBaseline}>
      {() => (
        <ListRecord
          q={listQ}
          head={{ title: t("requests.title") }}
          tabs={
            !authz.isLoading && hr ? (
              <TabNav label={t("requests.lanes")} overflow="scroll">
                {LANES.map((l) => (
                  <Link
                    key={l}
                    to="/people/requests"
                    search={{ lane: l === "all" ? undefined : l, status: status === "OPEN" ? undefined : status, sel }}
                    replace
                    className={tabClass}
                    aria-current={active === l ? "page" : undefined}
                  >
                    {t(`requests.lane.${l}`)}
                    <TabCount>{counts.data?.[l]}</TabCount>
                  </Link>
                ))}
              </TabNav>
            ) : undefined
          }
          filters={
            !authz.isLoading ? (
              <WorklistSegmentBar<RequestStatus | "ALL">
                label={t("requests.statuses")}
                value={status}
                onChange={(next) => set({ status: next })}
                items={STATUSES.map((x) => ({ id: x ?? "ALL", label: t(`requests.status.${x ?? "ALL"}`) }))}
              />
            ) : undefined
          }
          notes={decided ? <Receipt state="recorded" message={t(`requests.done.${decided.status}`, { kind: kindText(decided.kind) })} /> : undefined}
          list={
            list.data ? (
              list.data.items.length ? (
                <div ref={tableWrapRef}>
                  <Table
                    label={t("requests.list")}
                    rows={list.data.items}
                    rowId={(r) => r.id}
                    columns={makeColumns(true)}
                    mobileLayout="compact"
                    density="compact"
                    selected={sel}
                    onSelect={(id) => select(id)}
                  />
                </div>
              ) : (
                emptyNode
              )
            ) : null
          }
          foot={
            hasPager ? (
              <Pager
                offset={list.data!.offset}
                limit={REQUEST_PAGE}
                total={list.data!.total}
                onPage={(o) => void navigate({ search: (x) => ({ ...x, page: Math.floor(o / REQUEST_PAGE), sel }), replace: true })}
              />
            ) : undefined
          }
          record={
            sel && (selected || selectionState)
              ? {
                  id: sel,
                  label: t("requests.panel"),
                  title: selected ? kindText(selected.kind) : t("requests.panel"),
                  meta: selected && <Chip tone={statusOf(selected.status).tone}>{statusOf(selected.status).label}</Chip>,
                  closeLabel: t("requests.panel.close"),
                  onClose: () => select(undefined),
                  returnFocus: () => tableWrapRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(sel)}"]`),
                  children: selected ? <RequestPanelBody r={selected} hr={hr} onDecided={(out) => { setDecided(out); select(undefined); }} /> : selectionState,
                }
              : null
          }
          statusSegments={[
            { id: "scope", tone: "strong", content: t("requests.title") },
            { id: "lane", content: t(hr ? `requests.lane.${active}` : "requests.mine") },
            { id: "status", content: t(`requests.status.${status}`) },
            ...(selected ? [{ id: "selected", content: subjectText(selected) }] : []),
          ]}
        />
      )}
    </ExperienceSwitch>
  );
}
