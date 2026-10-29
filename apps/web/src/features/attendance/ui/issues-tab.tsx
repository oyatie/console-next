// SPDX-License-Identifier: LicenseRef-Proprietary
import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { LongTable } from "../../../ui/long-table/long-table";
import { exceptionsQuery } from "../api";
import { dateText } from "../present";
import { ReadPeriod } from "./read-period";

const route = getRouteApi("/app/attendance");
export function IssuesTab() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const query = useInfiniteQuery(exceptionsQuery(search.month ?? (search.date ?? todayKst()).slice(0, 7), search.wp));
  return <><ReadPeriod /><QueryState q={query} layout="list">{data => {
    const rows = data.pages.flatMap(page => page.items);
    return <LongTable label={t("attendance.tab.issues")} rows={rows} rowId={row => row.id} total={data.pages[0]!.total}
      hasMore={query.hasNextPage} loadingMore={query.isFetchingNextPage} onLoadMore={() => void query.fetchNextPage()}
      empty={t("attendance.issues.empty")} onRowAction={id => {
        const row = rows.find(item => item.id === id)!;
        void navigate({ search: s => ({ ...s, tab: "day", date: row.work_date, wp: row.branch_id ?? s.wp, person: undefined }) });
      }} columns={[
        { id: "person", header: t("attendance.col.person"), card: "title", rowHeader: true, cell: row => row.employee_name },
        { id: "date", header: t("attendance.col.date"), card: "fact", cell: row => dateText(row.work_date) },
        { id: "kind", header: t("attendance.col.kind"), card: "fact", cell: row => t(`attendance.exception.${row.kind}`) },
        { id: "state", header: t("attendance.col.state"), card: "status", cell: row => <Chip tone={row.status === "OPEN" ? "warn" : "ok"}>{t(`attendance.exception.${row.status}`)}</Chip> },
      ]} />;
  }}</QueryState></>;
}
