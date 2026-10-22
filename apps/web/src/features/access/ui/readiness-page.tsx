import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, Info, TriangleAlert } from "lucide-react";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { blocking, readiness, type Check as Item } from "../domain/readiness";
import { grantsQuery, type Account } from "../api";
import { personLabel } from "../../../reference/person/present";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import { grantPerson, periodText, storedScope } from "../present";
import { AccessHead } from "./access-head";
import { EnforcementChip } from "./holder";
import { useAccessContext } from "./use-access-context";
import { useOrgRoots } from "./use-org-roots";
import s from "./access.module.css";

const ICON = { ok: Check, bad: TriangleAlert, info: Info } as const;

function Row({ c, ops, accounts }: { c: Item; ops: string; accounts: readonly Account[] }) {
  const Icon = ICON[c.tone];
  const who = "account" in c ? c.account.name : ops;
  return (
    <div className={s.check}>
      <Icon size={18} className={s[c.tone]} aria-hidden />
      <div>
        <strong>{t(`access.ready.${c.code}`, { name: who })}</strong>
        {"account" in c && <div><PersonLabel person={accounts.find((a) => a.id === c.account.id) ?? c.account} peers={accounts} /></div>}
        <p>{t(`access.ready.${c.code}.text`, { name: who })}{"alsoNoPasskey" in c && c.alsoNoPasskey && <> {t("access.ready.alsoNoPasskey")}</>}</p>
      </div>
      {"account" in c && c.code !== "no_passkey" && <Link to="/access/people/$accountId" params={{ accountId: c.account.id }} search={{ grant: true }} className={buttonClass()}>{t("access.grant.title")}</Link>}
      {c.code === "no_passkey" && <Link to="/people" search={{ view: "accounts" }} className={buttonClass()}>{t("access.ready.no_passkey.fix")}</Link>}
      {c.code === "only_ops_manages" && <Link to="/access/roles/new" className={buttonClass("ghost")}>{t("access.roles.create")}</Link>}
      {c.code === "no_accounts" && <Link to="/people" search={{ view: "accounts" }} className={buttonClass("ghost")}>{t("access.ready.no_accounts.fix")}</Link>}
    </div>
  );
}

/**
 * go-live readiness (mockup M6): the grants go-live switches on, each listed, and the cases that would leave an HR worker
 * signing in to nothing (no grant, no passkey, a retired role). Ops is never reduced, so the tenant cannot lock itself
 * out; this screen guards the people next to ops. go-live itself stays on its own screen.
 */
export function ReadinessPage() {
  const ctx = useAccessContext();
  const roots = useOrgRoots();
  const grants = useQuery(grantsQuery());
  const manages = new Set(ctx.roles.filter((r) => r.lines.some((l) => l.domain === "access" && l.levels.includes("edit"))).map((r) => r.id));
  const opsName = ctx.accounts.find((a) => a.id === ctx.ops)?.display_name ?? "";
  return (
    <div className="page">
      <AccessHead
        actions={ctx.setup ? <Link to="/setup/go-live" className={buttonClass("primary")}><ArrowRight size={16} aria-hidden />{t("access.ready.goLive")}</Link> : undefined}
      />
      <QueryState q={grants}>
        {(g) => {
          const checks = readiness(
            ctx.accounts.map((a) => ({ ...a, name: personLabel(a).name, active: a.is_active })),
            g.items.map((x) => ({ account_id: x.account_id, enforcement: x.enforcement, manages_access: manages.has(x.role_id) })),
            ctx.ops,
          );
          const prepared = g.items.filter((x) => x.enforcement === "PREPARED");
          // governance-31: in setup the list holds grants already in force (from setup) and grants that wait for go-live;
          // the title counts both, so it adds up to the rows below.
          const enforced = g.items.filter((x) => x.enforcement === "ENFORCED");
          const title = ctx.setup
            ? `${t("accessGrants.ready.now", { count: enforced.length })} · ${t("accessGrants.ready.golive", { count: prepared.length })}`
            : t("access.ready.all", { count: g.items.length });
          return (
            <>
              <Card label={t("access.ready.checks", { count: blocking(checks) })} flush>
                {checks.map((c, i) => <Row key={`${c.code}:${"account" in c ? c.account.id : i}`} c={c} ops={opsName} accounts={ctx.accounts} />)}
              </Card>
              <Card
                title={title}
                meta={g.items.length > 0 && t("access.ready.spread", { people: new Set(g.items.map((x) => x.account_id)).size, roles: new Set(g.items.map((x) => x.role_id)).size })}
                flush
              >
                {g.items.length ? (
                  <Table
                    label={t("access.ready.list")}
                    rows={g.items}
                    rowId={(x) => x.id}
                    columns={[
                      { header: t("access.col.person"), cell: (x) => <Link to="/access/people/$accountId" params={{ accountId: x.account_id }}><PersonLabel person={grantPerson(x, ctx.accounts)} peers={ctx.accounts} /></Link> },
                      { header: t("access.col.number"), fit: true, cell: (x) => ctx.accounts.find((a) => a.id === x.account_id)?.employee_number ?? "" },
                      { header: t("access.col.role"), cell: (x) => x.role_name_ko },
                      { header: t("access.col.scope"), cell: (x) => storedScope(x.scope, roots) },
                      { header: t("access.col.until"), fit: true, cell: (x) => periodText(x) },
                      { header: t("access.col.state"), fit: true, cell: (x) => <EnforcementChip e={x.enforcement} /> },
                    ]}
                  />
                ) : (
                  <EmptyState title={t("access.grants.none")} reason={t("access.ready.none.reason")} />
                )}
              </Card>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
