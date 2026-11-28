// SPDX-License-Identifier: LicenseRef-Proprietary
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { DISPATCH_OFFERS_MODULE, moduleReady, modulesQuery } from "../../../reference/onboarding/api";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtMonth } from "@console/i18n/format";
import { CHANGE_REQUEST_STATUS, EMPLOYEE_STATUS, codeText, labeled } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup } from "../../../lib/react/query-view";
import { PageReadGate } from "../../../reference/authz/ui/access-gate";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { PageHead } from "../../../ui/page-head/page-head";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { RecordSection } from "../../../ui/record/record-section";
import {
  meUserQuery,
  myAttendanceExceptionsQuery,
  myAttendanceRecordsQuery,
  myAttendanceScheduleQuery,
  myAttendanceWeek52Query,
  myChangeRequestsQuery,
  myLeaveOverviewQuery,
  myPayslipsQuery,
  myProfileQuery,
} from "../api";
import { isoMondayOf } from "../domain/week";
import { MeAttendanceSections } from "./me-attendance-sections";
import s from "./me.module.css";

export type MeDeskView = "overview" | "attendance" | "requests" | "documents";
export type MeDeskSearch = { view?: MeDeskView };

const route = getRouteApi("/app/me/desk");
const VIEWS: readonly MeDeskView[] = ["overview", "attendance", "requests", "documents"];

const LazyDispatchOffers = lazy(() => import("./me-dispatch-offers-page").then(m => ({ default: m.MeDispatchOffersPage })));
export function MeDispatchOffers() { return <Suspense fallback={null}><LazyDispatchOffers /></Suspense>; }
export function MeDeskPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const view: MeDeskView = search.view ?? "overview";
  const today = todayKst();
  const month = today.slice(0, 7);
  const week = isoMondayOf(today);

  const calendar = useServedCapability("served_calendar");
  const me = useQuery(meUserQuery);
  const modules = useQuery(modulesQuery);
  const evaluations = useServedCapability("served_evaluation_tasks");
  const isLinked = me.data?.employee_link_status === "LINKED";
  const profile = useQuery({ ...myProfileQuery, enabled: isLinked, retry: false });
  const leave = useQuery({ ...myLeaveOverviewQuery, enabled: isLinked, retry: false });
  const payslips = useQuery({ ...myPayslipsQuery, enabled: isLinked, retry: false });
  const changes = useQuery({ ...myChangeRequestsQuery, enabled: isLinked, retry: false });
  const week52 = useQuery({ ...myAttendanceWeek52Query(week), enabled: isLinked, retry: false });
  const records = useQuery({ ...myAttendanceRecordsQuery(), enabled: isLinked, retry: false });
  const exceptions = useQuery({ ...myAttendanceExceptionsQuery(month), enabled: isLinked, retry: false });
  const schedule = useQuery({ ...myAttendanceScheduleQuery(month), enabled: isLinked, retry: false });

  const primary = readGroup([me]);
  const availableWeek52 = week52.data?.status === "available" ? week52.data.projection : undefined;
  const openRequestsCount = changes.data?.items.length ?? 0;

  const summary = isLinked ? (
    <StatRow
      label={t("me.desk.stat.label")}
      items={[
        { key: "empNo", label: t("account.stat.employeeNumber"), value: me.data?.employee_number ?? "—" },
        { key: "unit", label: t("account.field.unit"), value: me.data?.employee_org_unit ?? "—" },
        {
          key: "leave",
          label: t("me.desk.stat.leave"),
          value: leave.data?.balance?.remaining_units != null
            ? t("me.desk.stat.leaveValue", { days: Number(leave.data.balance.remaining_units) })
            : "—",
        },
        {
          key: "week52",
          label: t("me.attendance.week52.current"),
          value: availableWeek52
            ? t("me.attendance.week52.hours", { hours: availableWeek52.current_hours })
            : t("me.attendance.week52.notAvailable"),
          tone: availableWeek52 ? undefined : "muted",
        },
        {
          key: "requests",
          label: t("me.desk.stat.requests"),
          value: t("me.desk.stat.requestsValue", { count: openRequestsCount }),
        },
      ]}
    />
  ) : undefined;

  const viewsNav = (
    <nav aria-label={t("me.desk.views")} className={s.railStack}>
      {calendar && <Link to="/calendar">{t("internalCalendar.title")}</Link>}
      <div className={s.railNav}>
        {VIEWS.map(item => (
          <Button
            key={item}
            size="sm"
            variant={view === item ? "primary" : "ghost"}
            aria-pressed={view === item}
            className={s.nowrap}
            onClick={() => void navigate({ search: prev => ({ ...prev, view: item }) })}
          >
            {t(`me.desk.view.${item}`)}
          </Button>
        ))}
      </div>
      <div className={s.railLinks}>
        <Link to="/me/attendance" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>{t("me.desk.links.attendance")}</Link>
        {evaluations && <Link to="/me/evaluations" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>{t("me.evaluation.title")}</Link>}
        {moduleReady(modules.data, DISPATCH_OFFERS_MODULE) && <Link to="/me/dispatch-offers" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>{t("me.dispatch.link")}</Link>}
        <Link to="/payslips" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>{t("shell.title.payslip")}</Link>
        <Link to="/account/privacy" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>{t("me.desk.links.privacy")}</Link>
      </div>
    </nav>
  );

  const profileSection = (
    <RecordSection
      id="me-desk-profile"
      title={t("me.desk.profile.title")}
      tools={<Link to="/account" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>{t("me.desk.links.profile")}</Link>}
    >
      {!isLinked ? (
        <EmptyState compact title={t("account.status.unlinked")} reason={t("me.desk.profile.unlinked")} />
      ) : (
        <QueryState q={profile} compact>
          {p => (
            <KeyValue
              label={t("me.desk.profile.title")}
              items={[
                { key: "name", label: t("account.field.name"), value: me.data?.employee_name ?? me.data?.display_name ?? "—" },
                { key: "empNo", label: t("account.stat.employeeNumber"), value: me.data?.employee_number ?? "—" },
                { key: "unit", label: t("account.field.unit"), value: me.data?.employee_org_unit ?? "—" },
                { key: "status", label: t("attendance.col.state"), value: (() => {
                  const badge = labeled(EMPLOYEE_STATUS, p.employment_status ?? me.data?.employee_employment_status ?? "ACTIVE");
                  return <Chip tone={badge.tone}>{badge.label}</Chip>;
                })() },
                { key: "phone", label: t("account.selfEdit.phone"), value: p.phone_masked ?? "—" },
                { key: "address", label: t("account.selfEdit.address"), value: p.address_masked ?? "—" },
              ]}
            />
          )}
        </QueryState>
      )}
    </RecordSection>
  );

  const showChanges =
    view === "requests" ||
    (view === "overview" && (changes.isPending || changes.isError || (changes.data?.items.length ?? 0) > 0));
  const showPayslips =
    view === "documents" ||
    (view === "overview" && (payslips.isPending || payslips.isError || (payslips.data?.items.length ?? 0) > 0));

  const requestsSection = (
    <div className={s.panelSections}>
      <RecordSection
        id="me-desk-leave"
        title={t("me.desk.leave.title")}
        tools={<Link to="/leave" className={buttonClass("primary", { size: "sm", className: s.nowrap })}>{t("me.desk.links.leave")}</Link>}
      >
        <QueryState q={leave} compact>
          {data => (
            <LongTable
              label={t("me.desk.leave.title")}
              rows={data.requests.items}
              rowId={r => r.id}
              hasMore={false}
              onLoadMore={() => {}}
              mobileLayout="compact"
              empty={<EmptyState compact title={t("me.desk.leave.empty")} reason={null} />}
              columns={[
                { id: "period", header: t("me.attendance.records.col.date"), card: "fact", rowHeader: true, cell: r => `${fmtDate(r.start_date)} ~ ${fmtDate(r.end_date)}` },
                { id: "type", header: t("attendance.col.kind"), card: "title", cell: r => r.leave_type === "half_day" ? t(r.partial_day_period === "pm" ? "leave.type.halfPm" : "leave.type.halfAm") : t("leave.type.annual") },
                { id: "status", header: t("attendance.col.state"), card: "status", cell: r => {
                  const tone = r.status === "approved" ? "ok" : r.status === "rejected" || r.status === "returned" ? "danger" : r.status === "time_change_consult" ? "warn" : "info";
                  const key = r.status === "approved" ? "leave.status.approved" : r.status === "rejected" || r.status === "returned" ? "leave.status.rejected" : r.status === "time_change_consult" ? "leave.status.consult" : "leave.status.pending";
                  return <Chip tone={tone}>{t(key)}</Chip>;
                } },
              ]}
            />
          )}
        </QueryState>
      </RecordSection>
      {showChanges ? (
        <RecordSection
          id="me-desk-changes"
          title={t("me.desk.requests.title")}
          tools={<Link to="/people/requests" search={{ lane: "me" }} className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>{t("me.desk.links.requests")}</Link>}
        >
          <QueryState q={changes} compact>
            {data => (
              <LongTable
                label={t("me.desk.requests.title")}
                rows={data.items}
                rowId={r => r.id}
                hasMore={false}
                onLoadMore={() => {}}
                mobileLayout="compact"
                empty={<EmptyState compact title={t("me.desk.requests.empty")} reason={null} />}
                columns={[
                  { id: "kind", header: t("attendance.col.kind"), card: "title", rowHeader: true, cell: r => codeText(`requests.kind.${r.kind}`, r.kind) },
                  { id: "date", header: t("attendance.col.date"), card: "fact", cell: r => fmtDate(r.created_at) },
                  { id: "status", header: t("attendance.col.state"), card: "status", cell: r => {
                    const badge = labeled(CHANGE_REQUEST_STATUS, r.status);
                    return <Chip tone={badge.tone}>{badge.label}</Chip>;
                  } },
                ]}
              />
            )}
          </QueryState>
        </RecordSection>
      ) : null}
    </div>
  );

  const documentsSection = showPayslips ? (
    <RecordSection
      id="me-desk-payslips"
      title={t("me.desk.payslips.title")}
      tools={<Link to="/payslips" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>{t("shell.title.payslip")}</Link>}
    >
      <QueryState q={payslips} compact>
        {data => (
          <LongTable
            label={t("me.desk.payslips.title")}
            rows={data.items}
            rowId={d => d.id}
            hasMore={false}
            onLoadMore={() => {}}
            mobileLayout="compact"
            empty={<EmptyState compact title={t("me.desk.payslips.empty")} reason={null} />}
            columns={[
              { id: "title", header: t("account.hub.payslip"), card: "title", rowHeader: true, cell: d => d.payslip_meta?.attribution_month ? fmtMonth(d.payslip_meta.attribution_month) : d.title },
              { id: "date", header: t("attendance.col.date"), card: "fact", cell: d => fmtDate(d.payslip_meta?.pay_date ?? d.created_at) },
            ]}
          />
        )}
      </QueryState>
    </RecordSection>
  ) : null;

  const panel = !isLinked ? profileSection : (
    <div className={s.panelSections}>
      {(view === "overview" || view === "documents") && profileSection}
      {(view === "overview" || view === "attendance") && (
        <MeAttendanceSections
          schedule={schedule}
          recordsQuery={records}
          exceptions={exceptions.data?.items ?? []}
          exceptionsQuery={exceptions}
          compactScheduleWeekStart={view === "overview" ? week : undefined}
          fullScheduleLink={view === "overview"}
        />
      )}
      {(view === "overview" || view === "requests") && requestsSection}
      {(view === "overview" || view === "documents") && documentsSection}
    </div>
  );

  const baseline = () => (
    <main className="page" data-floorplan="P-05">
      <PageHead title={t("me.desk.title")} />
      <PageReadGate q={primary}>
        <QueryState q={primary} layout="record">
          {() => (
            <div className={s.baselineWrap}>
              {summary ? <Card title={t("me.desk.stat.label")}>{summary}</Card> : null}
              <Card title={t("me.desk.links.title")}>{viewsNav}</Card>
              {panel}
            </div>
          )}
        </QueryState>
      </PageReadGate>
    </main>
  );

  return (
    <SettingsPattern
      q={primary}
      head={{
        title: t("me.desk.title"),
        titleId: "me-desk-title",
      }}
      views={viewsNav}
      summary={summary}
      panel={panel}
      statusSegments={
        me.data
          ? [
              { id: "view", content: t(`me.desk.view.${view}`) },
              { id: "user", tone: "strong", content: me.data.employee_name ?? me.data.display_name ?? t("me.desk.title") },
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
