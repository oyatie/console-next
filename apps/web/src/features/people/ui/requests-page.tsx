import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { useCan } from "../../../reference/authz/ui/use-can";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Count } from "../../../ui/count/count";
import { EmptyState } from "../../../ui/empty-state";
import { Pager } from "../../../ui/pager";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table, type Column } from "../../../ui/table";
import { employeeQuery, mySub } from "../api";
import { openCountQuery, REQUEST_PAGE, requestsQuery, type ChangeRequest, type Lane, type RequestStatus } from "../api";
import { RequestPanel } from "./request-panel";
import { kindText, statusOf, subjectText } from "../present";
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
  const hr = can("employee_directory_manage", "all");
  const set = (patch: { lane?: Lane; status?: RequestStatus | "ALL"; sel?: string; page?: number }) =>
    void navigate({ search: (x) => ({ ...x, page: undefined, ...patch }), replace: true });
  const active = hr ? lane : "all";
  const list = useQuery(requestsQuery({ lane: active, mine: !hr, status: status === "ALL" ? undefined : status, offset: page * REQUEST_PAGE }));
  const counts = useQueries({ queries: LANES.map((l) => ({ ...openCountQuery(l), enabled: hr })) });
  const subjects = useQueries({ queries: [...new Set((list.data?.items ?? []).filter((r) => r.subject_type === "EMPLOYEE").map((r) => r.subject_id))].map((id) => employeeQuery(id)) });
  const names = new Map(subjects.flatMap((q) => (q.data ? [[q.data.employee.id, q.data.employee] as const] : [])));
  const columns: Column<ChangeRequest>[] = [
    { header: t("requests.col.kind"), cell: (r) => kindText(r.kind), fit: true },
    { header: t("requests.col.subject"), cell: (r) => subjectText(r, names.get(r.subject_id)), wide: true },
    { header: t("requests.col.reason"), cell: (r) => r.reason_code, wide: true },
    {
      header: t("requests.col.at"),
      cell: (r) => (
        <>
          <span className="num">{fmtDateTimeShort(r.created_at)}</span> {r.requested_by === mySub() && <Chip>{t("requests.mine")}</Chip>}
        </>
      ),
      fit: true,
    },
    { header: t("requests.col.status"), cell: (r) => <Chip tone={statusOf(r.status).tone}>{statusOf(r.status).label}</Chip>, fit: true },
    { header: t("requests.col.open"), cell: (r) => <Button variant="ghost" onClick={() => set({ sel: r.id })}>{t("requests.open")}</Button>, fit: true },
  ];
  const selected = list.data?.items.find((r) => r.id === sel);
  const [decided, setDecided] = useState<ChangeRequest | null>(null);
  return (
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
          {hr && (
            <div className="tabs" role="group" aria-label={t("requests.lanes")}>
              {LANES.map((l, i) => (
                <ToggleButton key={l} pressed={active === l} onClick={() => set({ lane: l })}>
                  {t(`requests.lane.${l}`)} <Count n={counts[i]!.data?.total} />
                </ToggleButton>
              ))}
            </div>
          )}
          <div className="tabs" role="group" aria-label={t("requests.statuses")}>
            {STATUSES.map((x) => (
              <ToggleButton key={x ?? "ALL"} pressed={(status === "ALL" ? undefined : status) === x} onClick={() => set({ status: x ?? "ALL" })}>
                {t(`requests.status.${x ?? "ALL"}`)}
              </ToggleButton>
            ))}
          </div>
          <QueryState q={list} empty={(d) => (d.items.length ? null : <EmptyState title={t("requests.none.title")} reason={t(hr ? "requests.none.hr" : "requests.none.mine")} />)}>
            {(d) => (
              <>
                <Table label={t("requests.list")} rows={d.items} rowId={(r) => r.id} columns={columns} selected={sel} onSelect={(id) => set({ sel: id })} />
                <Pager offset={d.offset} limit={REQUEST_PAGE} total={d.total} onPage={(o) => set({ page: Math.floor(o / REQUEST_PAGE), sel: sel })} />
              </>
            )}
          </QueryState>
        </section>
        {selected && <RequestPanel r={selected} subject={names.get(selected.subject_id)} hr={hr} onClose={() => set({ sel: undefined })} onDecided={(out) => (setDecided(out), set({ sel: undefined }))} />}
      </div>
    </div>
  );
}
