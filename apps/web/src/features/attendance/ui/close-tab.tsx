// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { branchesQuery } from "../../../reference/org/api";
import { Chip } from "../../../ui/chip";
import { LongTable } from "../../../ui/long-table/long-table";
import { closesQuery } from "../api";
import { monthText } from "../present";
import { ReadPeriod } from "./read-period";

const route = getRouteApi("/app/attendance");
export function CloseTab() {
  const search = route.useSearch();
  const board = useQuery(closesQuery(search.month ?? (search.date ?? todayKst()).slice(0, 7), search.wp));
  const branches = useQuery(branchesQuery);
  return <><ReadPeriod /><QueryState q={board} layout="list">{data => <QueryState q={branches} layout="list">{places => <>
    <h2>{t("attendance.close.heading", { month: monthText(data.month) })}</h2>
    <LongTable label={t("attendance.tab.close")} rows={data.items} rowId={row => row.branch_scope} hasMore={false} onLoadMore={() => {}}
      empty={t("attendance.close.empty")} columns={[
        { id: "place", header: t("attendance.col.workplace"), card: "title", rowHeader: true, cell: row => places.find(place => place.id === row.branch_scope)?.name ?? t("attendance.close.unavailable") },
        { id: "state", header: t("attendance.col.state"), card: "status", cell: row => <Chip tone={row.closed ? "ok" : "neutral"}>{t(row.closed ? "attendance.close.closed" : "attendance.close.open")}</Chip> },
        { id: "issues", header: t("attendance.tab.issues"), card: "fact", cell: row => t("attendance.count", { count: row.open_exceptions }) },
        { id: "leave", header: t("attendance.close.pendingLeave"), card: "fact", cell: row => t("attendance.count", { count: row.pending_leave }) },
      ]} />
  </>}</QueryState>}</QueryState></>;
}
