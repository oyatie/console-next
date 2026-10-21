import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { TENANT_STATUS, label } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { LANDED, landed } from "../../../lib/react/landed";
import { rereadTenants, setStatus, type Org, type Recorded } from "../api";
import { TARGET, type Move } from "../domain/tenants";

/** Suspend, archive or resume: the consequence, then the same verb-object on the commit. None is irreversible. */
export function StatusDialog({ org, move, onClose, onDone }: { org: Org; move: Move | null; onClose: () => void; onDone: (r: Recorded) => void }) {
  const change = useCommand({
    run: async (m: Move) => {
      // No idempotency key on a status change: a lost response or a 409 on a retry counts as done when a re-read shows the status.
      let fresh: Org | undefined;
      const r = await landed(() => setStatus(org.id, TARGET[m]), rereadTenants, (all) => (fresh = all.find((o) => o.id === org.id))?.status === TARGET[m]);
      return r === LANDED ? fresh! : r;
    },
    invalidates: ["/api/platform"],
    onSuccess: (o) => onDone({ message: t("tenants.status.done", { org: o.name, status: label(TENANT_STATUS, o.status) }), meta: t("tenants.recordedAt", { at: fmtDateTime(o.updated_at) }) }),
    announce: (o) => t("tenants.status.done", { org: o.name, status: label(TENANT_STATUS, o.status) }),
  });
  const close = () => {
    change.reset();
    onClose();
  };
  return (
    <Dialog open={move !== null} title={move ? t(`tenants.status.${move}`, { org: org.name }) : ""} onClose={close}>
      {move && (
        <>
          <span>{t(`tenants.status.${move}.consequence`, { org: org.name })}</span>
          <CommandError error={change.error} />
          <div className="form__actions">
            <Button onClick={close}>{t("common.back")}</Button>
            <Button variant="primary" disabled={change.isPending} onClick={() => change.mutate(move)}>{t(`tenants.status.${move}`, { org: org.name })}</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
