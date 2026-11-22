// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { EMPLOYEE_STATUS, EMPLOYMENT_TYPE, LIFECYCLE_EVENT, label, labeled } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { DueCell } from "../../../ui/due-cell/due-cell";
import type { LongColumn } from "../../../ui/long-table/long-table";
import { daysUntilDate, type TeamEmployee, type TeamLeaveRequest } from "../domain/team-scope";
import s from "./team.module.css";

export function buildTeamColumns(
  today: string,
  pendingLeaves: readonly TeamLeaveRequest[],
): LongColumn<TeamEmployee>[] {
  return [
    {
      id: "person",
      header: t("team.col.person"),
      card: "title",
      rowHeader: true,
      cell: r => (
        <div className={s.personCell}>
          <strong>{r.name}</strong>
          {r.employee_number ? <bdi className="muted num t-xs">{r.employee_number}</bdi> : null}
        </div>
      ),
    },
    { id: "position", header: t("team.col.position"), card: "fact", cell: r => r.position ?? "—" },
    {
      id: "type",
      header: t("team.col.type"),
      cell: r => (r.employment_type ? label(EMPLOYMENT_TYPE, r.employment_type) : "—"),
    },
    { id: "workplace", header: t("team.col.workplace"), card: "fact", cell: r => r.org_unit ?? r.company },
    {
      id: "status",
      header: t("team.col.status"),
      card: "status",
      cell: r => {
        const badge = labeled(EMPLOYEE_STATUS, r.status ?? "UNKNOWN");
        return <Chip tone={badge.tone}>{badge.label}</Chip>;
      },
    },
    {
      id: "nextSchedule",
      header: t("team.col.nextSchedule"),
      card: "omit",
      cell: r => {
        const days = daysUntilDate(r.next_event?.effective_date, today);
        return days !== null ? <DueCell days={days} nearWindow={14} /> : <bdi className="muted">—</bdi>;
      },
    },
    {
      id: "ongoing",
      header: t("team.col.ongoing"),
      card: "omit",
      cell: r => {
        const hasPendingLeave = pendingLeaves.some(req => req.subject_employee_id === r.id);
        if (r.next_event) {
          return <Chip tone="info">{label(LIFECYCLE_EVENT, r.next_event.event_type)}</Chip>;
        }
        if (hasPendingLeave) {
          return <Chip tone="warn">{t("leave.status.pending")}</Chip>;
        }
        return <bdi className="muted">—</bdi>;
      },
    },
  ];
}
