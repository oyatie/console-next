// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button-base";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { HandoffState } from "../../../ui/handoff/handoff";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import type { AttendanceMonthCloseItem, ClosePreflight } from "../api";
import s from "./attendance-console.module.css";

export function CloseConsoleActions({
  row,
  activePreflight,
  preflightError,
  preflightPending,
  onRunPreflight,
  onOpenConfirm,
  onOpenAmend,
}: {
  row: AttendanceMonthCloseItem;
  activePreflight: ClosePreflight | null;
  preflightError: unknown;
  preflightPending: boolean;
  onRunPreflight: () => void;
  onOpenConfirm: () => void;
  onOpenAmend: () => void;
}) {
  return (
    <>
      {row.close?.period_lock_id ? (
        <RecordPaneSection title={t("attendance.close.handoffTitle")}>
          <HandoffState
            title={t("attendance.close.handoffTitle")}
            from={{ who: t("attendance.close.closed"), note: t("attendance.close.handoffSummary") }}
            to={{
              who: t("attendanceRecords.month.requestUnlock"),
              note: (
                <Link
                  to="/people/period-locks"
                  search={{ unlock: row.close.period_lock_id }}
                  className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
                >
                  {t("attendanceRecords.month.requestUnlock")}
                </Link>
              ),
            }}
          />
        </RecordPaneSection>
      ) : null}
      {!row.closed ? (
        <RecordPaneSection title={t("attendance.close.preflightTitle")}>
          <CommandError error={preflightError} />
          {activePreflight && (
            <KeyValue
              density="dense"
              label={t("attendance.close.preflightTitle")}
              items={activePreflight.checks.map((c, i) => ({
                key: `${c.key}-${i}`,
                label: c.note ?? c.key,
                value: (
                  <Chip tone={c.ok ? "ok" : c.warn ? "warn" : "danger"}>
                    {t(c.ok ? "attendance.close.readyChip" : c.warn ? "attendance.close.warningChip" : "attendance.close.blockerChip")}
                  </Chip>
                ),
              }))}
            />
          )}
          <div className={s.paneActions}>
            <Button
              size="sm"
              variant="secondary"
              className={s.nowrap}
              disabled={preflightPending}
              onClick={onRunPreflight}
            >
              {t("attendance.close.preflightRun")}
            </Button>
            {activePreflight && !activePreflight.can_close ? (
              <DisabledReason
                reason={t("attendance.close.blockedReason")}
                control={props => (
                  <Button {...props} size="sm" variant="primary" className={s.nowrap}>
                    {t("attendance.close.confirmButton")}
                  </Button>
                )}
              />
            ) : (
              <Button
                size="sm"
                variant="primary"
                className={s.nowrap}
                disabled={preflightPending}
                onClick={onOpenConfirm}
              >
                {t("attendance.close.confirmButton")}
              </Button>
            )}
          </div>
        </RecordPaneSection>
      ) : (
        <div className={s.paneActions}>
          <Button
            size="sm"
            variant="secondary"
            className={s.nowrap}
            onClick={onOpenAmend}
          >
            {t("attendance.close.amendButton")}
          </Button>
        </div>
      )}
    </>
  );
}
