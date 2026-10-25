import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { landed } from "../../../lib/react/landed";
import { conflict, removeTenant, rereadTenants, type Org, type Recorded } from "../api";

type Props = { org: Org; open: boolean; onClose: () => void; onDone: (r: Recorded) => void; onArchive: () => void };

const holdReason = (code: string) => code === "blocked_legal_hold" ? t("tenants.remove.legalHold") : undefined;

/** A removal with no idempotency key: a lost response counts as done when the tenant is gone on a re-read. */
const useRemove = (org: Org, force: boolean, onDone: (r: Recorded) => void) =>
  useCommand({
    run: async () => {
      await landed(() => removeTenant(org.id, force), rereadTenants, (all) => !all.some((o) => o.id === org.id));
    },
    invalidates: ["/api/platform"],
    onSuccess: () => onDone({ message: t("tenants.remove.done", { org: org.name }) }),
    announce: () => t("tenants.remove.done", { org: org.name }),
  });

/** Archiving is the way out of both refusals; offered when it is still a move from here. */
const ArchiveRemedy = ({ org, onArchive }: Pick<Props, "org" | "onArchive">) =>
  org.status === "ARCHIVED" ? null : <Button onClick={onArchive}>{t("tenants.status.archive", { org: org.name })}</Button>;

/** Guarded removal: only an empty onboarding shell goes (with its first admin); a tenant with data is refused. */
export function RemoveDialog({ org, open, onClose, onDone, onArchive }: Props) {
  const remove = useRemove(org, false, onDone);
  const hasData = conflict(remove.error, "tenant_has_data");
  const held = conflict(remove.error, "blocked_legal_hold");
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog open={open} title={t("tenants.remove", { org: org.name })} onClose={close}>
      <span>{t("tenants.remove.consequence")}</span>
      <span>{t("tenants.remove.adminToo")}</span>
      {hasData ? (
        <div className="alert" role="alert">{t("tenants.remove.hasData", { org: org.name })}</div>
      ) : (
        <CommandError error={remove.error} own={holdReason} />
      )}
      <div className="form__actions">
        <Button onClick={close}>{t("common.cancel")}</Button>
        {hasData ? <ArchiveRemedy org={org} onArchive={onArchive} /> : (
          <Button variant="danger" disabled={held || remove.isPending} onClick={() => remove.mutate(undefined)}>{t("tenants.remove", { org: org.name })}</Button>
        )}
      </div>
    </Dialog>
  );
}
