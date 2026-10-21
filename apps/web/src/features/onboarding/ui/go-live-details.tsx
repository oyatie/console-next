import { Link } from "@tanstack/react-router";
import type { GoLivePreview } from "@console/api/pending";
import { Chip } from "../../../ui/chip";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { SectionHead } from "../../../ui/card/section-head";
import { Table } from "../../../ui/table";
import { LongTable } from "../../../ui/long-table/long-table";
import { KeyValue } from "../../../ui/key-value/key-value";
import { EmptyState } from "../../../ui/empty-state";
import { buttonClass } from "../../../ui/button/button-class";

type Account = GoLivePreview["access_admin_holders"][number];

function Accounts({ title, rows }: { title: string; rows: Account[] }) {
  return <LongTable label={title} rows={rows} rowId={(r) => r.id} total={rows.length}
    hasMore={false} onLoadMore={() => undefined} empty={t("setup.golive.details.none")}
    columns={[{ id: "account", header: title, rowHeader: true, cell: (a) =>
      <Link to="/access/people/$accountId" params={{ accountId: a.id }} className={buttonClass("ghost")}>{a.name}</Link> }]} />;
}

/** Named records and permission scopes are part of the preview digest. */
export function GoLiveDetails({ p, changed = [] }: { p: GoLivePreview; changed?: string[] }) {
  const mark = (code: string) => changed.includes(code) && <Chip tone="warn">{t("setup.golive.changed")}</Chip>;
  return <>
    <section aria-labelledby="setup-breakdown">
      <SectionHead level={2} id="setup-breakdown">{t("setup.golive.details.breakdown")} {mark("breakdown")}</SectionHead>
      {p.breakdown.length ? <Table label={t("setup.golive.details.breakdown")} rows={p.breakdown} rowId={(r) => r.id} columns={[
        { header: t("setup.golive.details.place"), cell: (r) => `${t(r.kind === "legal_entity" ? "setup.golive.details.legal_entity" : "setup.golive.details.workplace")} · ${r.name}` },
        { header: t("setup.stats.people"), cell: (r) => fmtNumber(r.people) },
        { header: t("setup.golive.details.units"), cell: (r) => fmtNumber(r.units) },
      ]} /> : <EmptyState title={t("setup.golive.details.none")} reason={null} />}
    </section>
    <section aria-labelledby="setup-roles">
      <SectionHead level={2} id="setup-roles">{t("setup.golive.details.roles")} {mark("roles_becoming_active")}</SectionHead>
      <KeyValue items={[
        { key: "grants", label: t("setup.golive.details.role"), value: t("setup.golive.details.grants", { prepared: p.facts.prepared_grants, setup: p.facts.grants_effective_in_setup }) },
        { key: "accounts", label: t("setup.golive.details.holders"), value: t("setup.golive.details.accounts", { invited: p.facts.hr_accounts_invited, enrolled: p.facts.hr_accounts_enrolled }) },
      ]} />
      {p.roles_becoming_active.length ? <Table label={t("setup.golive.details.roles")} rows={p.roles_becoming_active} rowId={(r) => `${r.role_id}:${r.scope_kind}:${r.scope_id}`} columns={[
        { header: t("setup.golive.details.role"), cell: (r) => r.role },
        { header: t("setup.golive.details.holders"), cell: (r) => r.holders.map((a) => a.name).join(", ") },
        { header: t("setup.golive.details.scope"), cell: (r) => r.scope_kind === "TENANT" ? t("setup.golive.details.all") : r.scope },
      ]} /> : <EmptyState title={t("setup.golive.details.noPrepared")} reason={null} />}
      {mark("access_admin_holders")}<Accounts title={t("setup.golive.details.accessAdmins")} rows={p.access_admin_holders} />
      {mark("hr_accounts_with_no_grant")}<Accounts title={t("setup.golive.details.noGrant")} rows={p.hr_accounts_with_no_grant} />
    </section>
  </>;
}
