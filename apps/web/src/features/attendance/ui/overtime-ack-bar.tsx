// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button-base";
import { buttonClass } from "../../../ui/button/button-class";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { CommandError } from "../../../lib/react/command-error";
import type { Week52Row } from "../api";
import s from "./attendance-console.module.css";

export function OvertimeAckBar({
  row,
  date,
  wp,
  pending,
  error,
  onAck,
}: {
  row: Week52Row;
  date: string;
  wp?: string;
  pending: boolean;
  error: unknown;
  onAck: () => void;
}) {
  return (
    <>
      <CommandError error={error} />
      <div className={s.paneActions}>
        {row.acked ? (
          <DisabledReason
            reason={t("attendance.overtime.alreadyAcked")}
            control={props => (
              <Button {...props} size="sm" variant="secondary" className={s.nowrap}>
                {t("attendance.overtime.ackButton")}
              </Button>
            )}
          />
        ) : (
          <Button
            size="sm"
            variant="primary"
            className={s.nowrap}
            disabled={pending}
            onClick={onAck}
          >
            {t("attendance.overtime.ackButton")}
          </Button>
        )}
        <Link
          to="/attendance"
          search={{ tab: "overtime", month: date.slice(0, 7), person: row.employee_id, wp }}
          className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
        >
          {t("attendance.overtime.pane.openCard")}
        </Link>
      </div>
    </>
  );
}
