import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LogOut, UserX } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { refusalText } from "../../../reference/crud/present";
import { endOptionsQuery } from "../api";

/**
 * The two ways a person's record ends, always in view where the person is (in the record's action row, the roster's side panel):
 * exit and registration cancel. The one the server offers is a button; the other stays in place with the reason, and an open exit
 * case links to itself. `onAct` opens the record's sheet (`exit.report`, `cancel`); without it they link to the record.
 */
export function EndActions({ id, onAct, onOpenCase }: { id: string; onAct?: (act: "exit.report" | "cancel") => void; onOpenCase?: () => void }) {
  const end = useQuery(endOptionsQuery(id)).data;
  if (!end) return null;
  const go = (act: "exit.report" | "cancel", label: string, icon: ReactNode, id2: string) =>
    onAct ? (
      <Button key={act} id={id2} onClick={() => onAct(act)}>{icon}{label}</Button>
    ) : (
      <Link key={act} id={id2} className="btn" to="/people/$id" params={{ id }} search={{ act }}>{icon}{label}</Link>
    );
  const exitLabel = t("crud.person.exit");
  const cancelLabel = t("crud.person.cancel");
  const exitIcon = <LogOut size={16} aria-hidden />;
  const cancelIcon = <UserX size={16} aria-hidden />;
  return (
    <>
      {end.exit.allowed && end.can_report_exit ? (
        go("exit.report", exitLabel, exitIcon, "act-person-exit")
      ) : (
        <DisabledReason
          layout="inline"
          control={(p) => <Button {...p} id="act-person-exit">{exitIcon}{exitLabel}</Button>}
          reason={end.can_report_exit ? refusalText(end.exit.refusal) : t("crud.noPermission")}
          remedy={end.open_exit_case_id && (onOpenCase ? <Button variant="ghost" onClick={onOpenCase}>{t("person.exit.open")}</Button> : <Link to="/people/exits/$id" params={{ id: end.open_exit_case_id }} search={{}}>{t("person.exit.open")}</Link>)}
        />
      )}
      {end.cancel.allowed && end.can_cancel ? (
        go("cancel", cancelLabel, cancelIcon, "act-person-cancel")
      ) : (
        <DisabledReason
          layout="inline"
          control={(p) => <Button {...p} id="act-person-cancel">{cancelIcon}{cancelLabel}</Button>}
          reason={end.can_cancel ? refusalText(end.cancel.refusal) : t("crud.noPermission")}
        />
      )}
    </>
  );
}
