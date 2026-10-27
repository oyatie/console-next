// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { AccessGate, PageReadGate } from "../../../reference/authz/ui/access-gate";
import { joinReview } from "../domain/roster";
import { useUnplacedQueue, personOf } from "./use-unplaced-queue";
import { RosterHead } from "./roster-head";
import { RosterTable } from "./roster-table";
import { RosterFoot } from "./roster-foot";

const route = getRouteApi("/app/people");

/** The same unplaced queue as the placement workflow, presented with the roster's table. */
export function UnplacedRoster({ manage, switcher }: { manage: boolean; switcher?: ReactNode }) {
  const navigate = route.useNavigate();
  const { peopleAccess } = route.useRouteContext();
  return <>
    <RosterHead manage={manage} status="current" review={[]} unplaced switcher={switcher} onView={view => void navigate({ search: previous => ({ ...previous, placement: undefined, status: view.status === "current" ? undefined : view.status, review: joinReview(view.review ?? []) }), replace: true })} />
    <AccessGate {...peopleAccess.unplaced} layout="list"><UnplacedRows manage={manage} /></AccessGate>
  </>;
}

function UnplacedRows({ manage }: { manage: boolean }) {
  const queue = useUnplacedQueue();
  const navigate = route.useNavigate();
  const [find, setFind] = useState("");
  const rows = (queue.data?.items ?? []).map(personOf).filter(person => !find || `${person.name} ${person.employee_number ?? ""}`.toLocaleLowerCase().includes(find.toLocaleLowerCase()));
  return <PageReadGate q={queue}>
    <QueryState q={queue} layout="list">{data => <>
      {manage && <Link className={buttonClass()} to="/people/unplaced">{t("roster.unplaced.place")}</Link>}
      <RosterTable label={t("people.table")} today={todayKst()} shown={["entity", "unit", "position", "type", "hired"]} density="compact" rows={rows} total={data.count} hasMore={false} onLoadMore={() => void queue.refetch()} onRowAction={id => void navigate({ to: "/people/$id", params: { id }, search: {} })} find={{ label: t("roster.find"), defaultValue: find, onFind: setFind }} empty={<EmptyState title={t("people.noMatch.title")} reason={t("people.noMatch.filters")} actions={find && <Button onClick={() => setFind("")}>{t("people.filter.reset")}</Button>} />} />
      <RosterFoot shown={rows.length} total={data.count} />
    </>}</QueryState>
  </PageReadGate>;
}
