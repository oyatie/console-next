import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { renewalQueueQuery } from "../api";
import { CONTRACT_SOON_DAYS, addDays } from "../domain/lifecycle";
import type { Done } from "./person-act";

/**
 * The lifecycle receipt's follow-ups, away from any commit: back to the sheet a detour started from (the draft is
 * still there), the sending legal entity's settlement a group transfer opened, or the next renewal in Home's queue (H1+
 * auto-advance, placed away from the primary).
 */
export function LifecycleReceiptActions({ done, employeeId, onAct }: { done: Done; employeeId: string; onAct: (act: string) => void }) {
  const queue = useQuery({ ...renewalQueueQuery(addDays(todayKst(), CONTRACT_SOON_DAYS + 1)), enabled: Boolean(done.renewal) });
  const others = queue.data?.items.filter((x) => x.id !== employeeId) ?? [];
  const left = queue.data ? queue.data.total - (queue.data.items.length - others.length) : 0;
  const back = done.back;
  return (
    <>
      {back && (
        <Button onClick={() => onAct(back)}>
          {back.startsWith("cancel:") ? t("lifecycle.back.cancel") : back === "exit.report" ? t("lifecycle.back.to", { action: t("exit.report") }) : t("lifecycle.back.to", { action: t(`people.lifecycle.action.${back as "TRANSFER"}`) })}
        </Button>
      )}
      {done.settlement && (
        <Link className={buttonClass()} to="/people/exits/$id" params={{ id: done.settlement.caseId }}>
          {t("groupTransfer.receipt.settlement", { entity: done.settlement.entity })}
        </Link>
      )}
      {done.renewal && others[0] && (
        <Link className="btn" to="/people/$id" params={{ id: others[0].id }} search={{ act: "CONTRACT_RENEWAL" }}>
          {t("lifecycle.receipt.nextRenewal", { count: left })}
        </Link>
      )}
    </>
  );
}
