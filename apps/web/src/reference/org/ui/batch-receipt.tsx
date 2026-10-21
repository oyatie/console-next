import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Undo2 } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Receipt } from "../../../ui/receipt/receipt";
import { BATCH_READS, undoCommitted, type Committed } from "../api/setup-batch";

/**
 * The receipt of a setup batch (D18): what was made, kept until the user leaves, with one undo for the whole
 * commit and the links to the chart and to change history (the durable undo). `again` starts another list.
 */
export function CommittedReceipt({ committed, message, again, againLabel }: { committed: Committed; message: string; again: () => void; againLabel?: string }) {
  const [undone, setUndone] = useState(false);
  const undo = useCommand({
    run: (_: undefined, key: string) => undoCommitted(key, committed),
    invalidates: BATCH_READS,
    announce: () => t("orgBulk.undone"),
    onSuccess: () => setUndone(true),
  });
  if (undo.isPending) return <Receipt state="sending" message={t("orgBulk.undoing")} />;
  return (
    <>
      <Receipt
        state="recorded"
        message={undone ? t("orgBulk.undone") : message}
        meta={t("orgBulk.doneMeta")}
        actions={
          <>
            {!undone && (
              <Button onClick={() => undo.mutate(undefined)}>
                <Undo2 size={16} aria-hidden /> {t("orgBulk.undo")}
              </Button>
            )}
            <Link to="/org" search={{}} className={buttonClass()}>{t("orgBulk.viewChart")}</Link>
            <Link to="/org/history" className={buttonClass()}>{t("orgBulk.viewHistory")}</Link>
            <Button variant="ghost" onClick={again}>{againLabel ?? t("orgBulk.again")}</Button>
          </>
        }
      />
      {undo.error != null && <CommandError error={undo.error} />}
    </>
  );
}
