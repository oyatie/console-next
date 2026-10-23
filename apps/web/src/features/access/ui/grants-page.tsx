import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { todayKst } from "../../../lib/pure/today";
import { Banner } from "../../../ui/banner/banner";
import { Button, ToggleButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { SearchField } from "../../../ui/search/search-field";
import { SelectField } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import { ENDING_DAYS, filterGrants } from "../domain/grant-filter";
import { grantsQuery, type AccessGrant, type Account } from "../api";
import { accountLabel, grantPerson, periodText, scopeText } from "../present";
import { PersonLabel, PersonRecordLink } from "../../../reference/person/ui/person-label";
import { AccessHead } from "./access-head";
import { AccessRequests } from "./access-requests";
import { AccountPick } from "./account-pick";
import { GrantChange, type ChangeMode } from "./grant-change";
import { EnforcementChip } from "./holder";
import { GrantSheet } from "./grant-sheet";
import { GrantUndo } from "./grant-undo";
import { useAccessContext } from "./use-access-context";
import { useOrgRoots } from "./use-org-roots";
import s from "./access.module.css";

/** The grant's state; a grant on a deactivated account reads paused with its fix (people-self-46), never in effect. */
export const GrantState = ({ g, fresh }: { g: AccessGrant; fresh: boolean }) =>
  !g.account_active ? (
    <span className={s.stack}><Chip tone="warn">{t("accessGrants.paused")}</Chip><span className={s.src}>{t("accessGrants.paused.fix")}</span></span>
  ) : (
    <span className={s.chips}>{fresh && <Chip tone="ok">{t("accessGrants.fresh")}</Chip>}<EnforcementChip e={g.enforcement} /></span>
  );

/**
 * the grants list (mockup M7, governance-23): every live grant with a find box over name · employee number · role, a role filter and
 * "ending within 30 days"; who holds it with employee number · unit, over what with today's headcount, its last day, whether the
 * holder has a passkey, its state, and change end · revoke on the row. A saved grant leaves a receipt with undo.
 */
export function GrantsPage({ role }: { role?: string }) {
  const ctx = useAccessContext();
  const roots = useOrgRoots();
  const grants = useQuery(grantsQuery(role ? { role_id: role } : undefined));
  const [granting, setGranting] = useState<Account | null>(null);
  const [changing, setChanging] = useState<{ g: AccessGrant; mode: ChangeMode } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ message: string; grants: AccessGrant[]; operationId: string } | null>(null);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const today = todayKst();
  const fresh = new Set(saved?.grants.map((g) => g.id));
  const roleOptions = [{ id: "", label: t("accessGrants.role.all") }, ...ctx.roles.map((r) => ({ id: r.id, label: r.name_ko }))];
  return (
    <div className="page">
      <AccessHead actions={<Link to="/access/grants/bulk" className={buttonClass()}><Users size={16} aria-hidden />{t("access.bulk.open")}</Link>} />
      {done && <Banner live="polite">{done}</Banner>}
      {saved && <GrantUndo message={saved.message} grants={saved.grants} operationId={saved.operationId} onDone={(m) => (setSaved(null), setDone(m))} onDismiss={() => setSaved(null)} />}
      <Card label={t("access.grants.new")}>
        <AccountPick accounts={ctx.accounts} ops={ctx.ops} loading={ctx.accountsQ.isFetching} onPick={setGranting} />
      </Card>
      <Card
        title={t("access.grants.count", { count: grants.data?.items.length ?? 0 })}
        tools={role && <Link to="/access/grants" className={buttonClass("ghost")}>{t("access.grants.allRoles")}</Link>}
        flush
      >
        <div className={s.filters}>
          <SearchField label={t("accessGrants.find")} value={q} onChange={setQ} />
          {!role && <SelectField label={t("accessGrants.role")} hideLabel required={false} options={roleOptions} value={roleFilter ?? ""} onChange={(id) => setRoleFilter(id || null)} placeholder={t("accessGrants.role.all")} />}
          <ToggleButton size="sm" pressed={ending} onClick={() => setEnding(!ending)}>{t("accessGrants.ending", { days: ENDING_DAYS })}</ToggleButton>
        </div>
        <QueryState q={grants} empty={(d) => (d.items.length ? null : <EmptyState title={t("access.grants.none")} reason={t("access.grants.none.reason")} />)}>
          {(d) => {
            const rows = filterGrants(d.items, { q, role: roleFilter, ending }, today);
            if (!rows.length) return <EmptyState title={t("accessGrants.none.filtered")} reason={t("accessGrants.none.filtered.reason")} />;
            return (
              <Table
                label={t("accessGrants.shown", { shown: rows.length, total: d.items.length })}
                rows={rows}
                rowId={(g) => g.id}
                tone={(g) => (g.account_active ? undefined : "warn")}
                columns={[
                  { header: t("access.col.person"), cell: (g) => <><Link to="/access/people/$accountId" params={{ accountId: g.account_id }}><PersonLabel person={grantPerson(g, ctx.accounts)} peers={ctx.accounts} linked={false} /></Link> <PersonRecordLink person={grantPerson(g, ctx.accounts)} peers={ctx.accounts} /></> },
                  { header: t("access.col.role"), cell: (g) => g.role_name_ko },
                  { header: t("access.col.scope"), cell: (g) => scopeText(roots, g.scope) },
                  { header: t("access.col.until"), fit: true, cell: (g) => periodText(g) },
                  { header: t("access.col.passkey"), fit: true, cell: (g) => t(g.account_has_passkey ? "accessGrants.passkey.yes" : "accessGrants.passkey.no") },
                  { header: t("access.col.state"), cell: (g) => <GrantState g={g} fresh={fresh.has(g.id)} /> },
                  {
                    header: <span className="sr-only">{t("access.roles.col.actions")}</span>,
                    fit: true,
                    cell: (g) => (
                      <span className={s.actions}>
                        <Button variant="ghost" aria-label={t("access.change.end.label", { name: accountLabel(grantPerson(g, ctx.accounts), g.account_id, ctx.accounts), role: g.role_name_ko })} onClick={() => setChanging({ g, mode: "end" })}>{t("access.change.mode.end")}</Button>
                        <Button variant="ghost-danger" aria-label={t("access.change.revoke.label", { name: accountLabel(grantPerson(g, ctx.accounts), g.account_id, ctx.accounts), role: g.role_name_ko })} onClick={() => setChanging({ g, mode: "revoke" })}>{t("access.change.mode.revoke")}</Button>
                      </span>
                    ),
                  },
                ]}
              />
            );
          }}
        </QueryState>
      </Card>
      {/* Last on the page: it appears once its read lands, so it moves nothing above it. */}
      <AccessRequests accounts={ctx.accounts} onGrant={setGranting} />
      {ctx.cat.data && ctx.rolesLoaded && granting && (
        <GrantSheet
          account={granting}
          me={ctx.me}
          ops={ctx.ops}
          cat={ctx.cat.data}
          roles={ctx.roles}
          setup={ctx.setup}
          onClose={() => setGranting(null)}
          onGranted={(m, made, operationId) => (setGranting(null), setDone(null), setSaved({ message: m, grants: made, operationId }))}
        />
      )}
      <GrantChange key={changing ? `${changing.g.id}:${changing.mode}` : "none"} grant={changing?.g ?? null} mode={changing?.mode} onClose={() => setChanging(null)} onDone={(m) => (setChanging(null), setDone(m))} />
    </div>
  );
}
