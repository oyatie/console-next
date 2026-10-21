import { contractOverlap } from "../api/contract-refusal";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { CONTRACT_KIND, label } from "../../../lib/labels";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";

export function ContractRefusal({ error, onCorrect }: { error: unknown; onCorrect: (id: string) => void }) {
  const conflict = contractOverlap(error);
  if (!conflict) return <CommandError error={error} />;
  return <CommandError error={error} own={() => t("facts.contract.overlap", { kind: label(CONTRACT_KIND, conflict.kind), start: fmtDate(conflict.start), end: conflict.end ? fmtDate(conflict.end) : t("facts.contracts.openEnd") })}>
    <Button onClick={() => onCorrect(conflict.id)}>{t("facts.contract.overlap.correct", { start: fmtDate(conflict.start) })}</Button>
  </CommandError>;
}
