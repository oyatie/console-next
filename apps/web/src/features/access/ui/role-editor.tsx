import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { readGroup } from "../../../lib/react/query-view";
import { QueryState } from "../../../lib/react/query-state";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Field, TextInput } from "../../../ui/field/field";
import { Table } from "../../../ui/table";
import { EmptyState } from "../../../ui/empty-state";
import { PersonLabel, PersonRef } from "../../../reference/person/ui/person-label";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { usePolicyRouted } from "../../../reference/settings/ui/use-policy-routed";
import { modulesQuery } from "../../../reference/onboarding/api";
import { fromLines, isEmpty, toLines, type Chosen } from "../domain/grid";
import { ACCESS_READS, accountsQuery, catalogQuery, createRole, grantsQuery, meQuery, roleQuery, roleVersionsQuery, updateRole, type AccessCatalog, type AccessGrant, type AccessRole } from "../api";
import { AccessHead } from "./access-head";
import { accountLabel, grantPerson, linesText } from "../present";
import { PermissionGrid } from "./permission-grid";
import { RoleDiff } from "./role-diff";
import { RolePreview } from "./role-preview";
import { useReasons } from "./use-reasons";
import s from "./access.module.css";

const OTHER = "OTHER";
type Draft = { name: string; description: string; grid: Chosen };
const sameLines = (a: Chosen, b: Chosen, order: string[]) => JSON.stringify(toLines(a, order)) === JSON.stringify(toLines(b, order));

/** Who a change reaches, by name (mockup M2), and whether any of them already works under it (granted from setup). */
function useHolders(role: AccessRole | undefined) {
  const grants = useQuery({ ...grantsQuery({ role_id: role?.id ?? "" }), enabled: !!role?.holder_count });
  const accounts = useQuery(accountsQuery);
  const live: readonly AccessGrant[] = grants.data?.items ?? [];
  const holders = [...new Map(live.map((g) => [g.account_id, g])).values()];
  const names = holders.map((g) => accountLabel(grantPerson(g, accounts.data?.items ?? []), g.account_id, accounts.data?.items));
  return { grants, holders, accounts: accounts.data?.items ?? [], names: names.join(", "), now: live.some((g) => g.enforcement === "ENFORCED"), waiting: live.length > 0 && live.every((g) => g.enforcement === "PREPARED") };
}

function RoleVersions({ role }: { role: AccessRole }) {
  const versions = useQuery(roleVersionsQuery(role.id));
  const reasons = useReasons();
  return <Card title={t("access.role.versions")} flush>
    <QueryState q={versions} layout="list">{rows => rows.length ? <Table
      label={t("access.role.versions")} rows={rows} rowId={row => String(row.version)}
      columns={[
        { header: t("access.role.version.column"), fit: true, cell: row => row.version },
        { header: t("access.roles.col.name"), cell: row => row.name_ko },
        { header: t("access.roles.col.lines"), cell: row => linesText(row.lines) },
        { header: t("access.role.version.at"), cell: row => fmtDateTime(row.created_at) },
        { header: t("access.grant.reason"), cell: row => reasons.codes.find(code => code.code === row.reason_code)?.label ?? row.reason_code ?? t("access.role.version.noReason") },
      ]}
    /> : <EmptyState title={t("access.role.versions.empty")} reason={null} />}</QueryState>
  </Card>;
}

function Editor({ cat, role, copy, setup }: { cat: AccessCatalog; role?: AccessRole; copy: boolean; setup: boolean }) {
  const nav = useNavigate();
  const order = cat.domains.map((x) => x.domain);
  const start: Draft = role ? { name: copy ? t("access.role.copyName", { name: role.name_ko }) : role.name_ko, description: role.description ?? "", grid: fromLines(role.lines) } : { name: "", description: "", grid: {} };
  const [d, setD] = useState<Draft>(start);
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [tried, setTried] = useState(false);
  const reasons = useReasons();
  const modules = useQuery(modulesQuery);
  const exitRouted = usePolicyRouted("exit");
  const orgRouted = usePolicyRouted("org_structure");
  const routed = new Set([...(exitRouted ? ["exit"] : []), ...(orgRouted ? ["org_structure"] : [])]);
  const editing = role && !copy ? role : undefined;
  // Changing what a held role allows changes access for its holders now: it carries a reason and a passkey.
  const changed = !sameLines(d.grid, start.grid, order);
  const held = !!editing && editing.holder_count > 0 && changed;
  const problems = !d.name.trim() || isEmpty(d.grid) || (held && reasonProblem(reason, OTHER) !== null);
  const run = useCommand({
    run: () => {
      const body = { name_ko: d.name.trim(), description: d.description.trim() || null, lines: toLines(d.grid, order) };
      return editing ? updateRole(editing, body, changed, held ? { reason_code: reason.code!, reason_note: reason.memo.trim() || null } : undefined) : createRole(body);
    },
    invalidates: ACCESS_READS,
    announce: (r) => t("access.role.saved", { name: r.name_ko }),
    onSuccess: () => void nav({ to: "/access/roles" }),
  });
  const save = () => (problems ? setTried(true) : run.mutate(undefined));
  const holders = editing?.holder_count ?? 0;
  const who = useHolders(editing);
  const effect = holders && !who.grants.isSuccess ? (who.grants.isPending ? t("common.loading") : undefined) : !holders ? t("access.role.effect.none")
    : !setup ? t("access.role.effect.live", { count: holders, names: who.names })
    : t(who.now ? "access.role.effect.setup" : "access.role.effect.golive", { count: holders, names: who.names });
  return (
    <div className={s.editor}>
      <div className={s.stack}>
        <Card label={t("access.role.basics")}>
          <div className={s.two}>
            <Field label={t("access.role.name")} required error={tried && !d.name.trim() ? t("access.role.name.missing") : undefined}>
              {(p) => <TextInput {...p} value={d.name} maxLength={60} onChange={(e) => setD({ ...d, name: e.target.value })} />}
            </Field>
            <Field label={t("access.role.description")} required={false}>
              {(p) => <TextInput {...p} value={d.description} maxLength={200} onChange={(e) => setD({ ...d, description: e.target.value })} />}
            </Field>
          </div>
        </Card>
        <Card title={t("access.role.grid")} flush>
          <PermissionGrid domains={cat.domains} value={d.grid} routed={routed} payrollReady={modules.data?.some((m) => m.key === "payroll" && m.ready) ?? false} onChange={(grid) => setD({ ...d, grid })} />
          {tried && isEmpty(d.grid) && <p className={`field__error ${s.pad}`} role="alert">{t("access.role.grid.missing")}</p>}
        </Card>
        {editing && <Card title={t("access.roles.col.holders")} meta={holders ? t(who.waiting ? "access.role.meta.golive" : "access.role.meta", { count: holders }) : undefined} flush>
          {holders ? <QueryState q={who.grants} layout="list">{() => <ul className={s.held}>
            {who.holders.map(g => {
              const account = who.accounts.find(a => a.id === g.account_id);
              return <li key={g.account_id}>
                <Link to="/access/people/$accountId" params={{ accountId: g.account_id }}><PersonLabel person={grantPerson(g, who.accounts)} peers={who.accounts} linked={false} wrap /></Link>
                {account && <PersonRef account={account} details={false} wrap />}
              </li>;
            })}
          </ul>}</QueryState> : <EmptyState title={t("access.role.effect.none")} reason={null} />}
        </Card>}
        {editing && <RoleVersions role={editing} />}
      </div>
      <aside className={`card ${s.preview}`} aria-labelledby="ac-preview">
        <h2 id="ac-preview">{t("access.preview.title")}</h2>
        <RolePreview domains={cat.domains} grid={d.grid} routed={routed} />
        {held && <RoleDiff before={start.grid} after={d.grid} order={order} />}
        {held && <ReasonField label={t("access.role.reason")} codes={reasons.codes} other={OTHER} value={reason} onChange={setReason} memoMax={200} showErrors={tried} />}
        <ActionBar
          notice={<PasskeyError error={run.error} />}
          consequence={effect}
          actions={
            <>
              <Link to="/access/roles" className={buttonClass("ghost")}>{t("access.cancel")}</Link>
              <Button variant="primary" disabled={run.isPending || Boolean(holders && !who.grants.isSuccess)} onClick={save}>{t(held ? "access.role.save.held" : editing ? "access.role.save" : "access.role.create")}</Button>
            </>
          }
        />
      </aside>
    </div>
  );
}

/** role editor (mockup M2): a new role, a copy of one (`copy`), or an existing role (`roleId`). */
export function RoleEditorPage({ roleId, copy }: { roleId?: string; copy?: string }) {
  const cat = useQuery(catalogQuery);
  const me = useQuery(meQuery);
  const source = roleId ?? copy;
  const role = useQuery({ ...roleQuery(source ?? ""), enabled: !!source });
  const title = roleId ? t("access.role.title.edit") : copy ? t("access.role.title.copy") : t("access.role.title.new");
  const setup = me.data?.phase !== "OPERATING";
  const held = roleId ? role.data : undefined;
  return (
    <div className="page">
      <AccessHead />
<QueryState q={readGroup(source ? [cat, role] : [cat])} back={{ to: "/access/roles", label: t("access.role.back") }} layout="form">{() => <>      <>
      <div className={s.titleRow}>
        <Link to="/access/roles" className={buttonClass("ghost")}><ChevronLeft size={16} aria-hidden />{t("access.role.back")}</Link>
        <h2 className="page__title">{held ? t("access.role.title.named", { title, name: held.name_ko }) : title}</h2>
        {held && <Chip>{t("access.role.version", { version: held.version })}</Chip>}
        {held && (held.holder_count ? <Chip tone="ok">{t("access.roles.state.used")}</Chip> : <Chip>{t("access.roles.state.unused")}</Chip>)}
      </div>
      <Editor key={role.data ? `${role.data.id}:${role.data.version}` : "new"} cat={cat.data!} role={role.data} copy={!roleId && Boolean(source)} setup={setup} />
      </>
    </>}</QueryState>
    </div>
  );
}
