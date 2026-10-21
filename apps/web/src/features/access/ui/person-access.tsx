import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, Plus } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { orgStructureRef } from "../../../reference/entity/api";
import { LEVELS } from "../domain/grid";
import type { OrgNode } from "../domain/scope";
import { effectiveQuery, grantsQuery, type AccessEffectiveEntry, type AccessGrant } from "../api";
import { domainText, levelText, scopeText, untilText } from "../present";
import { AccessHead } from "./access-head";
import { GrantChange, type ChangeMode } from "./grant-change";
import { GrantSheet } from "./grant-sheet";
import { EnforcementChip, PersonHead } from "./holder";
import { useAccessContext } from "./use-access-context";
import { useReasons } from "./use-reasons";
import s from "./access.module.css";

/**
 * "what this person can do" (mockup M6, design §8.1): every domain the account reaches, at which levels, over what, and the
 * grant behind it (role, who granted it and when, until when, why); then the domains it does not reach. One state shared by
 * every row is said once in the head.
 */
function CanDo({ entries, order, grants, roots }: { entries: AccessEffectiveEntry[]; order: string[]; grants: readonly AccessGrant[]; roots: readonly OrgNode[] }) {
  const ctx = useAccessContext();
  const reasons = useReasons();
  const states = new Set(entries.map((e) => e.enforcement));
  const seen = new Set<string>();
  const source = (r: AccessEffectiveEntry) => {
    if (seen.has(r.grant_id)) return t("access.person.source.same", { role: r.role_name_ko });
    seen.add(r.grant_id);
    const g = grants.find((x) => x.id === r.grant_id);
    const by = ctx.accounts.find((a) => a.id === g?.granted_by)?.display_name ?? "";
    const reason = reasons.codes.find((c) => c.code === g?.reason_code)?.label ?? g?.reason_code ?? "";
    return t("access.person.source", { role: r.role_name_ko, by, on: g ? fmtDateTime(g.granted_at) : "", until: untilText(r.valid_to), reason });
  };
  const reached = order.filter((d) => entries.some((e) => e.domain === d));
  const rest = (ctx.cat.data?.domains ?? []).filter((d) => d.grantable && !reached.includes(d.domain)).map((d) => domainText(d.domain));
  return (
    <div className={s.acc}>
      {reached.map((d) => {
        const rows = entries.filter((e) => e.domain === d);
        return (
          <Fragment key={d}>
            <strong>{domainText(d)}</strong>
            <div className={s.stack}>
              {[...new Set(rows.map((r) => r.grant_id))].map((id) => {
                const mine = rows.filter((r) => r.grant_id === id);
                const r = mine[0]!;
                return (
                  <div key={id}>
                    <div className={s.chips}>
                      {LEVELS.filter((l) => mine.some((x) => x.level === l)).map((l) => <Chip key={l} tone="info">{levelText(l)}</Chip>)}
                      <span>{scopeText(roots, r.scope)}</span>
                      {states.size > 1 && <EnforcementChip e={r.enforcement} />}
                    </div>
                    <span className={s.src}>{source(r)}</span>
                    {/* AX-5: what this line does not reach over a scope narrower than the tenant, as the server says. */}
                    {r.caveats.length > 0 && <span className={s.src}>{r.caveats.map((c) => codeText(`accessCodes.caveat.${c}`, c)).join(" · ")}</span>}
                  </div>
                );
              })}
            </div>
          </Fragment>
        );
      })}
      {rest.length > 0 && <><span className="muted">{t("access.person.rest")}</span><span className="muted">{t("access.person.rest.text", { domains: rest.join(", ") })}</span></>}
    </div>
  );
}

/** effective access by person (mockup M6): what one account may do and the grants behind it, with grant, end change and revoke in place. */
export function PersonAccess({ accountId, grant: openGrant = false }: { accountId: string; grant?: boolean }) {
  const ctx = useAccessContext();
  const tree = useQuery(orgStructureRef);
  const eff = useQuery(effectiveQuery(accountId));
  const grants = useQuery(grantsQuery({ account_id: accountId }));
  const [granting, setGranting] = useState(openGrant);
  const [changing, setChanging] = useState<{ g: AccessGrant; mode: ChangeMode } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string>();
  const account = ctx.accounts.find((a) => a.id === accountId);
  const order = ctx.cat.data?.domains.map((d) => d.domain) ?? [];
  const roots = (tree.data?.entities ?? []) as OrgNode[];
  const held = grants.data?.items ?? [];
  const one = eff.data && new Set(eff.data.entries.map((e) => e.enforcement)).size === 1 ? eff.data.entries[0]?.enforcement : undefined;
  return (
    <div className="page">
      <AccessHead />
      <div className={s.titleRow}>
        <Link to="/access/grants" className={buttonClass("ghost")}><ChevronLeft size={16} aria-hidden />{t("access.nav.grants")}</Link>
        {account ? <PersonHead a={account} ops={account.id === ctx.ops} title={<h2 className={s.personTitle}>{account.display_name}</h2>} /> : <h2 className="page__title">{t("access.person.title")}</h2>}
        <span className="grow" />
        {account && <Button variant="primary" onClick={() => setGranting(true)}><Plus size={16} aria-hidden />{t("access.grant.title")}</Button>}
      </div>
      {done && <Banner live="polite">{done}{operationId && <p><Link to="/requests/$id" params={{ id: operationId }}>{t("requestOutcome.open")}</Link></p>}</Banner>}
      {/* One loading card until both reads land, so the grants card is never pushed down under a pointer. */}
      {eff.isPending || grants.isPending ? <Card><QueryState q={eff.isPending ? eff : grants}>{() => null}</QueryState></Card> : (
        <div className={s.editor}>
          <Card
            title={t("access.person.can", { name: account?.display_name ?? "" })}
            meta={one === "PREPARED" ? <Chip tone="info">{t("access.person.fromGoLive")}</Chip> : one && one !== "ENFORCED" && <EnforcementChip e={one} />}
            flush
          >
            <QueryState q={eff}>
              {(e) =>
                e.is_ops ? <div className={s.pad}><Banner>{t("access.person.ops")}</Banner></div>
                : e.entries.length ? <CanDo entries={e.entries} order={order} grants={held} roots={roots} />
                : <EmptyState title={t("access.person.none", { name: account?.display_name ?? "" })} reason={t(e.phase === "SETUP" ? "access.person.none.setup" : "access.person.none.reason")} />
              }
            </QueryState>
          </Card>
          <Card title={t("access.grants.count", { count: held.length })} flush>
            {held.length ? (
              <ul className={s.held}>
                {held.map((g) => (
                  <li key={g.id}>
                    <span className={s.stack}>
                      <strong>{g.role_name_ko}</strong>
                      <span className={s.src}>{scopeText(roots, g.scope)} · {untilText(g.valid_to)}</span>
                    </span>
                    <span className={s.actions}>
                      <Button variant="ghost" aria-label={t("access.change.end.label", { name: g.account_display_name ?? "", role: g.role_name_ko })} onClick={() => setChanging({ g, mode: "end" })}>{t("access.change.mode.end")}</Button>
                      <Button variant="ghost-danger" aria-label={t("access.change.revoke.label", { name: g.account_display_name ?? "", role: g.role_name_ko })} onClick={() => setChanging({ g, mode: "revoke" })}>{t("access.change.mode.revoke")}</Button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t("access.grants.none")} reason={t("access.person.grants.none")} />
            )}
          </Card>
        </div>
      )}
      {granting && account && ctx.cat.data && ctx.rolesLoaded && (
        <GrantSheet account={account} me={ctx.me} ops={ctx.ops} cat={ctx.cat.data} roles={ctx.roles} setup={ctx.setup} onClose={() => setGranting(false)} onGranted={(m, _made, id) => (setGranting(false), setDone(m), setOperationId(id))} />
      )}
      <GrantChange key={changing ? `${changing.g.id}:${changing.mode}` : "none"} grant={changing?.g ?? null} mode={changing?.mode} onClose={() => setChanging(null)} onDone={(m) => (setChanging(null), setDone(m), setOperationId(undefined))} />
    </div>
  );
}
