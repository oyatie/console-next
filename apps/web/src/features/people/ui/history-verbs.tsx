import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { cancellable, correctable, voidable } from "../domain/lifecycle";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import type { LifecycleEvent } from "../api";

type Employee = components["schemas"]["Employee"];

/**
 * The verbs a history row offers (BW-11): a reservation is changed or withdrawn, a record that failed to apply is recorded
 * again, the latest change in force is corrected or rescinded. The ribbon and the card's spine both read them here.
 */
export function rowVerbs(x: LifecycleEvent, { employee, all, offered, onAct }: { employee: Employee; all: readonly LifecycleEvent[]; offered: (type: string) => boolean; onAct: (act: string) => void }) {
  const action = label(LIFECYCLE_EVENT, x.event_type);
  return cancellable(x) ? (
    <>
      {offered(x.event_type) && <Button variant="ghost" onClick={() => onAct(`edit:${x.id}`)}>{t("person.history.edit", { action })}</Button>}
      <Button variant="ghost-danger" onClick={() => onAct(`cancel:${x.id}`)}>{t("people.event.cancel", { action })}</Button>
    </>
  )
    : x.state === "SCHEDULED" ? <Button variant="ghost" onClick={() => focusSoon("exit")}>{t("person.history.exitCancel")}</Button>
    : x.state === "APPLY_FAILED" && employee.failed_event?.id === x.id && offered(x.event_type) ? <Button variant="ghost" onClick={() => onAct(`again:${x.id}`)}>{t("person.next.retry")}</Button>
    : voidable(x, all) ? (
      <>
        {correctable(x, all) ? <Button variant="ghost" onClick={() => onAct(`correct:${x.id}`)}>{t("person.history.correct")}</Button>
          : <DisabledReason layout="inline" control={(p) => <Button variant="ghost" {...p}>{t("person.history.correct")}</Button>} reason={t("lifecycle.correct.groupTransfer")} />}
        <Button variant="ghost-danger" onClick={() => onAct(`rescind:${x.id}`)}>{t("person.history.rescind")}</Button>
      </>
    )
    : undefined;
}
