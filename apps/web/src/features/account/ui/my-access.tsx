import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { myAccessQuery } from "../../../reference/authz/api";
import { grantLines } from "../../../reference/authz/present";
import { orgStructureRef } from "../../../reference/entity/api";

type Node = { id: string; name: string; children?: readonly Node[] };

/** What the server decides this account may do (one source with the ops view and every refused screen). */
function Grants() {
  const me = useQuery(myAccessQuery);
  const tree = useQuery(orgStructureRef);
  if (me.isPending) return <span className="muted" role="status">{t("common.loading")}</span>;
  if (me.isError) return <span className="muted">{t("common.loadFailed.title")}</span>;
  if (me.data.is_ops) return <span>{t("account.access.ops")}</span>;
  const lines = grantLines(me.data.entries, (tree.data?.entities ?? []) as readonly Node[]);
  // people-self-13: an account with no grant says what it can do today, never a capability it does not have.
  if (!lines.length) return <span className="muted">{t("account.access.none")}</span>;
  return (
    <ul className="list-plain">
      {lines.map((g) => (
        <li key={g.id}>
          <strong>{g.role}</strong> · {[g.scope, g.until, g.state].filter(Boolean).join(" · ")}
          <div className="muted">{g.reach}</div>
          {g.caveats.length > 0 && <div className="muted">{g.caveats.join(" · ")}</div>}
        </li>
      ))}
    </ul>
  );
}

/**
 * My access (operations catalog governance-22): what I may do and why — each grant I hold with its role, scope, end and
 * state, never a title, with what a narrower scope does not reach. The last card of My account, so its late answer moves
 * nothing below it. Tenant accounts only.
 */
export function MyAccessCard() {
  return (
    <section className="card" aria-labelledby="acct-access">
      <div className="toolbar">
        <h2 id="acct-access" className="toolbar__title">{t("account.access.title")}</h2>
      </div>
      <div className="card__body"><Grants /></div>
    </section>
  );
}
