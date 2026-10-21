import { t } from "@console/i18n";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { OutcomeLink } from "../../../lib/react/outcome-link";
import { Receipt } from "../../../ui/receipt/receipt";
import type { AccessGrant } from "../api";
import { useGrantBatch } from "./use-grant-batch";

/**
 * The receipt a saved grant leaves (mockup M4-saved, ROL-M4-grant-saved): what was granted, and undo — the server's
 * undo, which revokes exactly those grants as "correcting a mistaken grant" with the actor's passkey (high-risk, #26).
 */
export function GrantUndo({ message, grants, operationId, onDone, onDismiss }: { message: string; grants: readonly AccessGrant[]; operationId: string; onDone: (message: string) => void; onDismiss: () => void }) {
  const undo = useGrantBatch({ onSuccess: () => onDone(t("accessGrants.undone")) });
  return (
    <>
      <Receipt
        state="applied"
        message={message}
        actions={<OutcomeLink id={operationId} />}
        undoing={undo.isPending}
        onUndo={() => undo.mutate({ operations: grants.map((g) => ({ op: "revoke" as const, grant_id: g.id })), reason_code: "ERROR_CORRECTION", reason_note: null })}
        onDismiss={onDismiss}
      />
      <PasskeyError error={undo.error} />
    </>
  );
}
