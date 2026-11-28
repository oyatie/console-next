// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import {
  EMPLOYEE_STATUS,
  EMPLOYMENT_TYPE,
  LIFECYCLE_EVENT,
  label,
  labeled,
} from "../../../lib/labels";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { operationAccess } from "../../../reference/authz/domain/operation-access";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { ItemList } from "../../../ui/item-list/item-list";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { teamAccessQuery } from "../api";
import type { TeamEmployee, TeamLeaveRequest } from "../domain/team-scope";
import s from "./team.module.css";

export function TeamRecordPane({
  member,
  leaveRequests,
  moreLeaves,
}: {
  member: TeamEmployee;
  leaveRequests: readonly TeamLeaveRequest[];
  moreLeaves?: ReactNode;
}) {
  const access = useQuery(teamAccessQuery);
  const canManage = Boolean(
    access.data && accessRefusal(access.data, operationAccess["POST /api/v1/employees"]) === null,
  );
  const status = labeled(EMPLOYEE_STATUS, member.status ?? "UNKNOWN");
  const empType = member.employment_type ? label(EMPLOYMENT_TYPE, member.employment_type) : "—";
  const memberLeaves = leaveRequests.filter(item => item.subject_employee_id === member.id);

  return (
    <div>
      <RecordIdentityBar
        name={member.name}
        number={member.employee_number ?? undefined}
        badges={<Chip tone={status.tone}>{status.label}</Chip>}
        roleLine={[member.position, empType].filter(Boolean).join(" · ")}
        path={[member.company, member.org_unit].filter(Boolean).join(" › ")}
      />

      <RecordPaneSection title={t("team.pane.section.summary")}>
        <KeyValue
          density="dense"
          label={t("team.pane.section.summary")}
          items={[
            { key: "place", label: t("team.col.workplace"), value: member.org_unit ?? member.company },
            { key: "type", label: t("team.col.type"), value: empType },
            { key: "hire", label: t("team.pane.hireDate"), value: member.hire_date ? fmtDate(member.hire_date) : "—" },
            ...(member.next_event
              ? [
                  {
                    key: "next",
                    label: t("team.pane.nextEvent"),
                    value: `${label(LIFECYCLE_EVENT, member.next_event.event_type)} · ${fmtDate(member.next_event.effective_date)}`,
                  },
                ]
              : []),
          ]}
        />
      </RecordPaneSection>

      {memberLeaves.length > 0 || moreLeaves ? (
        <RecordPaneSection title={t("team.pane.section.leave")}>
          {memberLeaves.length > 0 && <ItemList
            label={t("team.pane.section.leave")}
            items={memberLeaves.map(req => ({
              key: req.id,
              text: `${fmtDate(req.start_date)} ~ ${fmtDate(req.end_date)}`,
              end: (
                <Chip tone="warn">
                  {t(
                    req.leave_type === "half_day"
                      ? req.partial_day_period === "pm"
                        ? "leave.type.halfPm"
                        : "leave.type.halfAm"
                      : "leave.type.annual",
                  )}
                </Chip>
              ),
            }))}
          />}
          {moreLeaves}
        </RecordPaneSection>
      ) : null}

      <RecordPaneSection title={t("team.pane.section.actions")}>
        <div className={s.actionsGrid}>
          <Link
            to="/people/$id"
            params={{ id: member.id }}
            className={buttonClass("primary", { size: "sm", className: s.nowrap })}
          >
            {t("team.pane.action.openCard")}
          </Link>
          {canManage ? (
            <>
              <Link
                to="/people/$id"
                params={{ id: member.id }}
                search={{ act: "TRANSFER" }}
                className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
              >
                {t("team.pane.action.appoint")}
              </Link>
              <Link
                to="/people/$id"
                params={{ id: member.id }}
                search={{ act: "LEAVE_OF_ABSENCE" }}
                className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
              >
                {t("team.pane.action.leave")}
              </Link>
              <Link
                to="/people/requests"
                className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
              >
                {t("team.pane.action.changeRequest")}
              </Link>
            </>
          ) : null}
        </div>
      </RecordPaneSection>
    </div>
  );
}
