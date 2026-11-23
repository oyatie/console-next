// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup } from "../../../lib/react/query-view";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { Card } from "../../../ui/card/card";
import { PageHead } from "../../../ui/page-head/page-head";
import { RecordPattern } from "../../../ui/patterns/record";
import { SelfServiceUnlinked } from "../../../reference/person/ui/self-service-unlinked";
import { PeriodStepper } from "../../../ui/period-stepper";
import {
  meUserQuery,
  myAttendanceExceptionsQuery,
  myAttendanceRecordsQuery,
  myAttendanceScheduleQuery,
  myAttendanceWeek52Query,
} from "../api";
import { isoMondayOf } from "../domain/week";
import { MeAttendanceSections, MeAttendanceStrip } from "./me-attendance-sections";
import s from "./me.module.css";

export type MeAttendanceSearch = { month?: string; week?: string };

const route = getRouteApi("/app/me/attendance");

export function MeAttendancePage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const today = todayKst();
  const month = search.month ?? today.slice(0, 7);
  const week = isoMondayOf(search.week ?? today);

  // An account with no employee record would only be refused these reads, so none is sent until users/me shows a link.
  const me = useQuery(meUserQuery);
  const linked = me.data?.employee_link_status === "LINKED";
  const week52 = useQuery({ ...myAttendanceWeek52Query(week), enabled: linked });
  const records = useQuery({ ...myAttendanceRecordsQuery(), enabled: linked });
  const exceptions = useQuery({ ...myAttendanceExceptionsQuery(month), enabled: linked });
  const schedule = useQuery({ ...myAttendanceScheduleQuery(month), enabled: linked, retry: false });

  const primary = readGroup(linked ? [week52, records, exceptions] : [me]);
  const go = (patch: Partial<MeAttendanceSearch>) => void navigate({ search: prev => ({ ...prev, ...patch }) });

  const filters = (
    <div className={s.filters}>
      <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={month} onChange={nextMonth => go({ month: nextMonth })} />
      <PeriodStepper
        unit="week"
        variant="boxed"
        showCurrent={false}
        value={week}
        onChange={nextWeek => go({ week: isoMondayOf(nextWeek) })}
      />
    </div>
  );

  if (me.data && !linked) {
    return <SelfServiceUnlinked q={me} title={t("me.attendance.title")} titleId="me-attendance-title" pattern="record" floorplan="P-02" queryLayout="record" />;
  }

  const baseline = () => (
    <main className="page" data-floorplan="P-02">
      <PageHead
        title={t("me.attendance.title")}
        crumbs={[<Link key="account" to="/account">{t("shell.profile")}</Link>]}
        filters={filters}
      />
      <PageReadGate q={primary}>
        <QueryState q={primary} layout="record">
          {() => (
            <div className={s.baselineWrap}>
              <Card title={t("me.attendance.stripLabel")}>
                <MeAttendanceStrip week52={week52.data} schedule={schedule} exceptions={exceptions.data?.items} />
              </Card>
              <MeAttendanceSections
                schedule={schedule}
                records={records.data?.items ?? []}
                exceptions={exceptions.data?.items ?? []}
              />
            </div>
          )}
        </QueryState>
      </PageReadGate>
    </main>
  );

  return (
    <RecordPattern
      q={primary}
      head={{
        title: t("me.attendance.title"),
        titleId: "me-attendance-title",
        crumbs: [<Link key="account" to="/account" className={s.plainLink}>{t("shell.profile")}</Link>],
        filters,
      }}
      strip={<MeAttendanceStrip week52={week52.data} schedule={schedule} exceptions={exceptions.data?.items} />}
      sections={
        <MeAttendanceSections
          schedule={schedule}
          records={records.data?.items ?? []}
          exceptions={exceptions.data?.items ?? []}
        />
      }
      statusSegments={
        primary.data
          ? [
              { id: "month", content: t("me.attendance.status.month", { month }) },
              { id: "week", content: t("me.attendance.status.week", { week }) },
              { id: "records", tone: "strong", content: t("me.attendance.status.records", { count: records.data?.items.length ?? 0 }) },
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
