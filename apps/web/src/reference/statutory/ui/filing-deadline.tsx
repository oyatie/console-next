import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import type { FilingTask } from "../api";

/** A statutory deadline as the server computes it from the register: the date, days left, and its review state. */
type StatutoryDeadline = Pick<FilingTask, "due_date" | "due_in_days" | "deadline_status"> & { dates?: FilingTask["dates"] };

/** The date, D-n (or overdue; "without delay" or unknown with no date: never a guessed date) and the HOLD mark of one statutory deadline. */
export function FilingDeadline({ task }: { task: StatutoryDeadline }) {
  const days = task.due_in_days;
  return <div className="form">
    {task.due_date ? <><time dateTime={task.due_date}>{fmtDate(task.due_date)}</time><Chip tone={days !== null && days < 0 ? "danger" : "warn"}>
      {days === null ? t("statutory.unknown") : days < 0 ? t("statutory.overdue", { days: -days }) : days === 0 ? t("statutory.dueToday") : t("statutory.days", { days })}
    </Chip></> : <Chip tone="warn">{t(task.dates?.without_delay ? "statutory.withoutDelay" : "statutory.unknown")}</Chip>}
    {task.deadline_status === "HOLD" && <Chip tone="warn">{t("statutory.hold")}</Chip>}
  </div>;
}

