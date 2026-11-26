// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { GridCellBadge } from "../../../ui/person-day-grid/person-day-grid";
import type { GridRow } from "../api";
import { GLYPH, hours } from "../domain/day";

/** A day cell drawn from what the grid sends. It carries no leave, so no day is shown as leave. */
export function consoleCellContent(cell: GridRow["cells"][number]) {
  const marks = cell.marks ?? [];
  if (marks.length > 0) {
    if (marks.includes("NO_RECORD") || marks.includes("MISSING_OUT") || marks.includes("NO_SCHEDULE")) {
      return <GridCellBadge tone="blocking">{GLYPH.danger}</GridCellBadge>;
    }
    if (marks.includes("UNAPPROVED_EXCESS")) {
      const ot = cell.unrecognised > 0 ? `+${hours(cell.unrecognised)}` : (GLYPH.warn ?? "◆");
      return <GridCellBadge tone="unapproved">{ot}</GridCellBadge>;
    }
    if (marks.includes("WORK_ON_REST_DAY")) {
      return <GridCellBadge tone="unapproved">{t("attendance.monthConsole.grid.badge.holidayWork")}</GridCellBadge>;
    }
    if (marks.includes("ABSENT")) {
      return <GridCellBadge tone="absent">{t("attendanceRecords.cell.ABSENT")}</GridCellBadge>;
    }
    if (marks.includes("LATE")) {
      return <GridCellBadge tone="late">{t("attendance.monthConsole.grid.badge.late")}</GridCellBadge>;
    }
    if (marks.includes("EARLY_OUT")) {
      return <GridCellBadge tone="late">{t("attendance.monthConsole.grid.badge.earlyOut")}</GridCellBadge>;
    }
    if (marks.includes("AWAY")) {
      return <GridCellBadge tone="late">{t("attendance.monthConsole.grid.badge.away")}</GridCellBadge>;
    }
  }

  if (cell.plan_kind !== "WORK" && cell.plan_kind !== "NO_SCHEDULE") {
    return cell.recognised > 0
      ? <GridCellBadge tone="holiday">{t("attendance.monthConsole.grid.badge.holidayWork")}</GridCellBadge>
      : null;
  }

  switch (cell.entry_kind) {
    case "TIMES": {
      if (cell.recognised > 480) {
        const overtimeLabel = `+${hours(cell.recognised - 480)}`;
        return <GridCellBadge tone="overtime">{overtimeLabel}</GridCellBadge>;
      }
      if (cell.recognised === 480) {
        return <GridCellBadge tone="dot">·</GridCellBadge>;
      }
      return cell.recognised > 0 ? hours(cell.recognised) : null;
    }
    case "ABSENT":
      return <GridCellBadge tone="absent">{t("attendanceRecords.cell.ABSENT")}</GridCellBadge>;
    case "OUTSIDE_WORK":
      return <GridCellBadge tone="overtime">{t("attendanceRecords.cell.OUTSIDE_WORK")}</GridCellBadge>;
    case "BUSINESS_TRIP":
      return <GridCellBadge tone="overtime">{t("attendanceRecords.cell.BUSINESS_TRIP")}</GridCellBadge>;
    case "CLOCK_IN_ONLY":
      return <GridCellBadge tone="blocking">{GLYPH.danger}</GridCellBadge>;
    default:
      return null;
  }
}
