// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Building2, FileText, MoveRight, Pencil } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { EMPLOYMENT_TYPE, LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { operationAccess } from "../../../reference/authz/domain/operation-access";
import { moduleReady, modulesQuery } from "../../../reference/onboarding/api";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { Tabs, type TabItem } from "../../../ui/tabs/tabs";
import { employeeQuery } from "../api";
import { certificatesQuery } from "../api/certificates";
import { payslipDraftPeekQuery, personMonthPeekQuery } from "../api/peek";
import { rrnStatusQuery } from "../api/record";
import { retirementDate } from "../domain/employment";
import { offeredVerbs } from "../domain/roster";
import { plannedWhat } from "../present";
import { EndActions } from "./end-actions";
import { ExitPeek } from "./exit-peek";
import { buildPanelBasicItems, buildPanelSummaryItems } from "./roster-console-panel-data";
import { RosterPanelTabBody } from "./roster-console-panel-tabs";
import { StatusChip } from "./roster-table";
import { useCard } from "./use-card";
import { useLinkedAccount } from "./use-linked-account";
import s from "./roster.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
type PanelTab = "basic" | "history" | "attendance" | "payroll" | "docs" | "account";

export function RosterConsolePanel({
  id,
  today,
  unitTriggerRef,
  onOpenUnit,
}: {
  id: string;
  today: string;
  unitTriggerRef?: RefObject<HTMLButtonElement | null>;
  onOpenUnit?: (unitId: string) => void;
}) {
  const detail = useQuery(employeeQuery(id));
  return (
    <QueryState q={detail}>
      {d => <ConsolePeek d={d} today={today} unitTriggerRef={unitTriggerRef} onOpenUnit={onOpenUnit} />}
    </QueryState>
  );
}

function ConsolePeek({
  d,
  today,
  unitTriggerRef,
  onOpenUnit,
}: {
  d: Detail;
  today: string;
  unitTriggerRef?: RefObject<HTMLButtonElement | null>;
  onOpenUnit?: (unitId: string) => void;
}) {
  const [tab, setTab] = useState<PanelTab>("basic");
  const c = useCard(d);
  const navigate = useNavigate();
  const access = useQuery(myAccessQuery);
  const modules = useQuery(modulesQuery);
  const e = d.employee;
  const who = `${e.name} ${e.employee_number ?? ""}`.trim();

  const rrnRead = useQuery({ ...rrnStatusQuery(e.id), enabled: c.readable, retry: false });
  const canCerts = Boolean(access.data && accessRefusal(access.data, operationAccess["GET /api/v1/hr/certificates"]) === null);
  const certs = useQuery({ ...certificatesQuery(e.id), enabled: canCerts, retry: false });

  const month = today.slice(0, 7);
  const monthNum = Number(month.slice(5, 7));
  const payDate = `${month}-25`;
  const canAttendance = Boolean(
    access.data &&
      modules.data &&
      moduleReady(modules.data, "attendance") &&
      accessRefusal(access.data, operationAccess["GET /api/v1/attendance/people/{employee_id}/month"]) === null,
  );
  const canPayroll = Boolean(
    access.data &&
      modules.data &&
      moduleReady(modules.data, "payroll") &&
      accessRefusal(access.data, operationAccess["GET /api/v1/payroll/employees/{employeeId}/payslip-draft"]) === null,
  );
  const attMonth = useQuery({ ...personMonthPeekQuery(e.id, month), enabled: canAttendance && tab === "attendance", retry: false });
  const payDraft = useQuery({ ...payslipDraftPeekQuery(e.id, month, payDate), enabled: canPayroll && tab === "payroll", retry: false });
  const { linked } = useLinkedAccount(e, c.users);

  const placeParts = [c.place.entity, ...(e.workplace_id ? [c.place.workplace, ...c.place.path] : [t("empCard.unplaced")])].filter(Boolean);
  const place = placeParts.join(" › ");
  const gradeLabel = c.title(d.classification.grade_id);
  const roleLabel = c.title(d.classification.position_kind_id);
  const gradeRole = [gradeLabel ?? e.position, roleLabel].filter(Boolean).join(" · ");
  const empTypeLabel = d.employment?.employment_type ? label(EMPLOYMENT_TYPE, d.employment.employment_type) : null;
  const verbs = offeredVerbs(d);
  const firstAct = verbs[0];
  const m = d.employment ?? d.pending_employment;
  const planned = c.planned;
  const next = planned
    ? {
        date: planned.event_type === "TERMINATE" || planned.event_type === "OFFBOARD" ? retirementDate(planned.effective_date) : planned.effective_date,
        what: plannedWhat(planned, c.title),
      }
    : e.next_event && {
        date: e.next_event.event_type === "TERMINATE" ? retirementDate(e.next_event.effective_date) : e.next_event.effective_date,
        what: label(LIFECYCLE_EVENT, e.next_event.event_type),
      };

  const events = (c.events.data?.items ?? []).filter(x => x.state !== "CANCELLED");
  const recentEvents = [...events].sort((a, b) => b.effective_date.localeCompare(a.effective_date)).slice(0, 3);

  const openCard = (act?: string, cardTab?: "events" | "docs" | "ledger" | "access") =>
    void navigate({
      to: "/people/$id",
      params: { id: e.id },
      search: { ...(act ? { act } : {}), ...(cardTab ? { tab: cardTab } : {}) },
    });

  const panelTabs: TabItem[] = [
    { id: "basic", label: t("people.panel.tab.basic") },
    { id: "history", label: t("people.panel.tab.history") },
    ...(canAttendance ? [{ id: "attendance", label: t("people.panel.tab.attendance") }] : []),
    ...(canPayroll ? [{ id: "payroll", label: t("people.panel.tab.payroll") }] : []),
    ...(canCerts ? [{ id: "docs", label: t("people.panel.tab.docs"), count: certs.data?.items.length }] : []),
    ...(c.users ? [{ id: "account", label: t("people.panel.tab.account") }] : []),
  ];

  const { employmentItems, personalItems } = buildPanelBasicItems({
    e,
    c,
    who,
    today,
    gradeRole,
    phone: m?.phone_e164,
    rrnRecorded: rrnRead.data?.recorded,
    rrnMasked: rrnRead.data?.masked,
  });

  const summaryItems = buildPanelSummaryItems({
    e,
    month,
    monthNum,
    payDate,
    attMonth: attMonth.data,
    payDraft: payDraft.data,
  });

  return (
    <div className={s.peekConsole}>
      <RecordIdentityBar
        name={e.name}
        nameLevel={3}
        number={e.employee_number ?? t("people.number.none")}
        badges={
          <>
            <StatusChip status={e.status} />
            {empTypeLabel ? <Chip>{empTypeLabel}</Chip> : null}
          </>
        }
        roleLine={gradeRole}
        path={
          e.org_unit_id && onOpenUnit ? (
            <Button ref={unitTriggerRef} size="sm" variant="ghost" onClick={() => onOpenUnit(e.org_unit_id!)}>
              <Building2 size={12} aria-hidden="true" />
              {place}
            </Button>
          ) : (
            <bdi>{place}</bdi>
          )
        }
        actions={
          c.editable ? (
            <>
              {firstAct ? (
                <Button size="sm" variant="secondary" onClick={() => openCard(firstAct)}>
                  <MoveRight size={12} aria-hidden="true" />
                  {t("people.panel.act.appoint")}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => openCard("multi")}>
                <Pencil size={12} aria-hidden="true" />
                {t("people.panel.act.edit")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => openCard("cert")}>
                <FileText size={12} aria-hidden="true" />
                {t("people.panel.act.cert")}
              </Button>
            </>
          ) : null
        }
      />

      {e.status === "EXITED" && e.exit_date ? (
        <RecordPaneSection title={t("roster.status.EXITED.kept")}>
          <div className="stack">
            <ExitPeek id={e.id} exitDate={e.exit_date} today={today} />
          </div>
        </RecordPaneSection>
      ) : null}

      <div className={s.peekTabsWrap}>
        <Tabs label={t("people.panel.cardTitle")} items={panelTabs} selected={tab} onSelect={k => setTab(k as PanelTab)}>
          {active => (
            <RosterPanelTabBody
              active={active}
              d={d}
              c={c}
              monthNum={monthNum}
              employmentItems={employmentItems}
              personalItems={personalItems}
              summaryItems={summaryItems}
              events={events}
              recentEvents={recentEvents}
              certsItems={certs.data?.items ?? []}
              attMonthData={attMonth.data}
              next={next}
              linked={linked}
              openCard={openCard}
            />
          )}
        </Tabs>
        {c.manage ? <QueryState q={c.register}>{() => null}</QueryState> : null}
        {c.manage ? (
          <nav className="row" aria-label={t("crud.person.ends")}>
            <EndActions id={e.id} />
          </nav>
        ) : null}
      </div>
    </div>
  );
}
