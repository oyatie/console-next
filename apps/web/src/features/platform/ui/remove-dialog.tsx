import { useState } from "react";
import { t } from "@console/i18n";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { Field, TextInput } from "../../../ui/field/field";
import { landed } from "../../../lib/react/landed";
import { conflict, removeTenant, rereadTenants, type Org, type Recorded } from "../api";
import s from "./tenants.module.css";

type Props = { org: Org; open: boolean; onClose: () => void; onDone: (r: Recorded) => void; onArchive: () => void };

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
        <CommandError error={remove.error} />
      )}
      <div className="form__actions">
        <Button onClick={close}>{t("common.back")}</Button>
        {hasData ? <ArchiveRemedy org={org} onArchive={onArchive} /> : (
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(undefined)}>{t("tenants.remove", { org: org.name })}</Button>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Force removal of an archived tenant and all of its data: what goes, typed confirmation of the slug,
 * then the vendor's own passkey (step-up). It runs at once and cannot be undone; the audit trail stays.
 */
export function ForceRemoveDialog({ org, users, open, onClose, onDone, onArchive }: Props & { users: number | undefined }) {
  const remove = useRemove(org, true, onDone);
  const [typed, setTyped] = useState("");
  const match = typed === org.slug;
  const close = () => {
    setTyped("");
    remove.reset();
    onClose();
  };
  return (
    <Dialog open={open} title={t("tenants.remove.force", { org: org.name })} onClose={close}>
      <ul className={s.items}>
        <li>{users === undefined ? t("tenants.remove.force.items.usersUnknown") : t("tenants.remove.force.items.users", { count: users })}</li>
        <li>{t("tenants.remove.force.items.final")}</li>
        <li>{t("tenants.remove.force.items.now")}</li>
        <li>{t("tenants.remove.force.items.audit")}</li>
      </ul>
      <Field label={t("tenants.remove.force.typeSlug", { slug: org.slug })} required error={typed && !match ? t("tenants.remove.force.mismatch", { slug: org.slug }) : undefined}>
        {(p) => <TextInput {...p} className="code" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />}
      </Field>
      {conflict(remove.error, "tenant_active") ? (
        <div className="alert" role="alert">{t("tenants.remove.force.active", { org: org.name })}</div>
      ) : (
        <PasskeyError error={remove.error} />
      )}
      <div className="form__actions">
        <Button onClick={close}>{t("common.back")}</Button>
        {conflict(remove.error, "tenant_active") && <ArchiveRemedy org={org} onArchive={onArchive} />}
        <Button variant="danger" disabled={!match || remove.isPending} onClick={() => remove.mutate(undefined)}>{t("tenants.remove.force.commit", { org: org.name })}</Button>
      </div>
    </Dialog>
  );
}
