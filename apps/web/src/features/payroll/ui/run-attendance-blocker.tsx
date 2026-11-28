// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";
import { RegisterBlockerItem } from "../../../ui/patterns/register-totals-parts";

export function RunAttendanceBlocker({ runStatus }: { runStatus?: string }) {
  return (
    <RegisterBlockerItem
      badge={
        <Chip tone={runStatus === "BLOCKED_LEGAL_GATE" ? "danger" : "warn"}>
          {t("payroll.run.attendanceNotClosedChip")}
        </Chip>
      }
      note={t("payroll.run.attendanceNotClosedNote")}
    />
  );
}
