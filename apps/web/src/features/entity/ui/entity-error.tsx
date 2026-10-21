import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { Denied } from "../../../lib/react/denied";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { fieldLabel, fieldRefusal } from "../present";

/** A failed entity command: a screen's own words first, then each refused field with its reason, then the shared copy. */
export function EntityError({ error, own, historyHref }: { error: unknown; historyHref?: string; own?: (code: string) => string | undefined }) {
  return <CommandError error={error} fieldLabel={fieldLabel} historyHref={historyHref} own={(code) => own?.(code) ?? fieldRefusal(error)(code)} />;
}

/**
 * The entity record when it cannot be shown, typed, with a way back and never a retry that cannot help: deleted while it
 * was open (company-22; nothing of the stale record or its verbs is drawn), or not there for this reader — the server
 * does not say which of "none" and "out of scope" (no existence leak), so both are named, with what the account holds and
 * request access (company-19).
 */
export function EntityGone({ error, wasShown }: { error: unknown; wasShown: boolean }) {
  if (wasShown)
    return (
      <EmptyState
        title={t("denied.entity.deleted")}
        reason={t("denied.entity.deleted.reason")}
        actions={<Link to="/org/entities" className={buttonClass()}>{t("denied.entity.back")}</Link>}
      />
    );
  return <Denied error={error} title={t("denied.entity.title")} reason={t("denied.entity.reason")} />;
}
