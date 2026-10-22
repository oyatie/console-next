import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { focusSoon } from "../../../lib/react/announce";
import { confirmGrantNotice } from "../../../reference/authz/api";
import { grantLines, grantRefusal } from "../../../reference/authz/present";
import type { AccessEffectiveEntry } from "../../../reference/authz/api";
import { Button } from "../../../ui/button/button";

/** The inbox owns membership; this control only confirms the named grant. */
export function GrantNotice({ id, role, entries }: { id: string; role: string; entries: AccessEffectiveEntry[] }) {
  const line = grantLines(entries)[0];
  const scope = entries[0]?.scope;
  const disclosed = scope?.kind === "TENANT" || !!scope?.node_name;
  const confirm = useCommand({
    run: () => confirmGrantNotice(id),
    invalidates: ["/api/v1/access/me", "/api/v1/me/action-inbox"],
    onSuccess: () => focusSoon("inbox-title"),
    announce: () => t("home.grantNotices.done", { role }),
  });
  return <div>
    {line && scope && <div><strong>{line.role}</strong> · {line.scope} · {t("access.period.open", { from: fmtDate(entries[0]!.valid_from) })} · {line.until}
      {line.state && <span> · {line.state}</span>}<p>{line.reach}</p>{line.caveats.map((c) => <p key={c}>{c}</p>)}
    </div>}
    <Button variant="primary" disabled={!line || !disclosed || confirm.isPending} onClick={() => confirm.mutate(undefined)}>
      {t("home.grantNotices.confirm", { role })}
    </Button>
    <CommandError error={confirm.error} own={grantRefusal} />
  </div>;
}
