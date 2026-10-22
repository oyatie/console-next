import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { focusSoon } from "../../../lib/react/announce";
import { confirmGrantNotice } from "../../../reference/authz/api";
import { grantRefusal } from "../../../reference/authz/present";
import { Button } from "../../../ui/button/button";

/** The inbox owns membership; this control only confirms the named grant. */
export function GrantNotice({ id, role }: { id: string; role: string }) {
  const confirm = useCommand({
    run: () => confirmGrantNotice(id),
    invalidates: ["/api/v1/access/me", "/api/v1/me/action-inbox"],
    onSuccess: () => focusSoon("inbox-title"),
    announce: () => t("home.grantNotices.done", { role }),
  });
  return <div>
    <Button variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate(undefined)}>
      {t("home.grantNotices.confirm", { role })}
    </Button>
    <CommandError error={confirm.error} own={grantRefusal} />
  </div>;
}
