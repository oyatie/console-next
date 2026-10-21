import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { focusSoon } from "../../../lib/react/announce";
import { confirmGrantNotice, myAccessQuery } from "../../../reference/authz/api";
import { grantRefusal, unnoticed, type GrantLine } from "../../../reference/authz/present";
import { orgStructureRef } from "../../../reference/entity/api";
import { Button } from "../../../ui/button/button";
import { QueueSection } from "./change-rows";

type Node = { id: string; name: string; children?: readonly Node[] };

/**
 * Grants I hold that I have not yet confirmed (decisions D0.2): until I record that I was told of a grant, it does not
 * make me a second person for anyone else's request (a period unlock, a governed correction). One line per grant —
 * role, scope, end and reach — each with its own confirmation. Shows nothing when every grant is confirmed.
 */
export function GrantNotices() {
  const me = useQuery(myAccessQuery);
  const tree = useQuery(orgStructureRef);
  if (!me.data || me.data.is_ops) return null;
  const lines = unnoticed(me.data.entries, (tree.data?.entities ?? []) as readonly Node[]);
  if (!lines.length) return null;
  return (
    <QueueSection id="grant-notices" title={t("home.grantNotices.title", { count: lines.length })}>
      <ul className="list-plain">{lines.map((g) => <NoticeRow key={g.id} g={g} />)}</ul>
    </QueueSection>
  );
}

function NoticeRow({ g }: { g: GrantLine }) {
  const confirm = useCommand({
    run: () => confirmGrantNotice(g.id),
    invalidates: ["/api/v1/access/me"],
    // The last confirmation removes the section: keep focus on the page heading.
    onSuccess: () => focusSoon("grant-notices", "home-title"),
    announce: () => t("home.grantNotices.done", { role: g.role }),
  });
  return (
    <li className="form">
      <div className="row">
        <div className="grow">
          <strong>{g.role}</strong> · {[g.scope, g.until, g.state].filter(Boolean).join(" · ")}
          <div className="muted">{g.reach}</div>
        </div>
        <Button variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate(undefined)}>
          {t("home.grantNotices.confirm", { role: g.role })}
        </Button>
      </div>
      <CommandError error={confirm.error} own={grantRefusal} />
    </li>
  );
}
