import { isMessageId, t } from "@console/i18n";
import { Undo2 } from "lucide-react";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { BATCH_READS, refusalCode, undoEntityBatch, undoOrgBatch } from "../api";
import type { FeedRow } from "../domain/feed";

/**
 * One row's undo (R27): an icon button named for its row, or the same icon inert with the reason beside it.
 * A refusal the server names (a later change in the way, a created unit now in use) is said in its own words.
 */
export function UndoCell({ row, target }: { row: FeedRow; target: string }) {
  const undo = useCommand({
    run: async (batchId: string, key: string) => void (row.source === "org" ? await undoOrgBatch(key, batchId) : await undoEntityBatch(key, batchId)),
    invalidates: BATCH_READS,
    announce: () => t("orgHistory.undone"),
  });
  const label = t("orgHistory.undoLabel", { target });
  if ("block" in row.undo)
    return (
      <DisabledReason
        layout="inline"
        reason={t(`orgHistory.block.${row.undo.block}`)}
        control={(p) => <Button variant="ghost" aria-label={label} {...p}><Undo2 size={16} aria-hidden /></Button>}
      />
    );
  const { batchId } = row.undo;
  const code = `orgHistory.refused.${refusalCode(undo.error) ?? ""}`;
  return (
    <span className="row">
      <Button variant="ghost" aria-label={label} disabled={undo.isPending} onClick={() => undo.mutate(batchId)}>
        <Undo2 size={16} aria-hidden />
      </Button>
      {undo.error != null && (isMessageId(code) ? <span className="field__error" role="alert">{t(code)}</span> : <CommandError error={undo.error} />)}
    </span>
  );
}
