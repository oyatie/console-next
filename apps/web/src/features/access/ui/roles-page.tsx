import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { grantsQuery, rolesQuery, type AccessGrant, type AccessRole } from "../api";
import { linesText } from "../present";
import { AccessHead } from "./access-head";
import { RoleDelete } from "./role-delete";
import s from "./access.module.css";

/** No preset roles (decision #19): the empty state opens the role editor. */
function NoRoles() {
  return (
    <section className="card state" aria-labelledby="ac-empty">
      <h2 id="ac-empty" className="state__title">{t("access.roles.empty.title")}</h2>
    </section>
  );
}

/** Holders: the count (opens their grants), marked when every one of their grants waits for go-live. */
function Holders({ r, grants }: { r: AccessRole; grants: readonly AccessGrant[] }) {
  if (!r.holder_count) return <span className="muted">{t("access.people", { count: 0 })}</span>;
  const mine = grants.filter((g) => g.role_id === r.id);
  return (
    <span className={s.nowrap}>
      <Link to="/access/grants" search={{ role: r.id }}>{t("access.people", { count: r.holder_count })}</Link>
      {mine.length > 0 && mine.every((g) => g.enforcement === "PREPARED") && <Chip tone="info">{t("access.roles.fromGoLive")}</Chip>}
    </span>
  );
}

/** role list (mockup M1): every tenant role with what it allows, where it applies, who holds it; copy, edit or delete. */
export function RolesPage() {
  const roles = useQuery(rolesQuery);
  const grants = useQuery(grantsQuery());
  const [deleting, setDeleting] = useState<AccessRole | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const live = grants.data?.items ?? [];
  return (
    <div className="page">
      <AccessHead actions={<Link to="/access/roles/new" className={buttonClass("primary")}><Plus size={16} aria-hidden />{t("access.roles.create")}</Link>} />
      {done && <Banner live="polite">{done}</Banner>}
      <QueryState q={roles} empty={(d) => (d.items.length ? null : <NoRoles />)}>
        {(d) => (
          <>
            <Card label={t("access.roles.count", { count: d.items.length })} flush>
              <Table
                label={t("access.roles.count", { count: d.items.length })}
                rows={d.items}
                rowId={(r) => r.id}
                columns={[
                  { header: t("access.roles.col.name"), cell: (r) => <Link to="/access/roles/$roleId" params={{ roleId: r.id }}>{r.name_ko}</Link> },
                  { header: t("access.roles.col.lines"), cell: (r) => <span className="muted">{linesText(r.lines)}</span> },
                  // Roles carry no scope rule in the pilot (contract): the scope is chosen for each person at grant.
                  { header: t("access.roles.col.scope"), fit: true, cell: () => t("access.roles.scope.atGrant") },
                  { header: t("access.roles.col.holders"), fit: true, cell: (r) => <Holders r={r} grants={live} /> },
                  { header: t("access.roles.col.state"), fit: true, cell: (r) => (r.holder_count ? <Chip tone="ok">{t("access.roles.state.used")}</Chip> : <Chip>{t("access.roles.state.unused")}</Chip>) },
                  {
                    header: <span className="sr-only">{t("access.roles.col.actions")}</span>,
                    fit: true,
                    cell: (r) => (
                      <div className={s.actions}>
                        <Link to="/access/roles/new" search={{ copy: r.id }} className={buttonClass("ghost")} aria-label={t("access.roles.copy.label", { name: r.name_ko })}>{t("access.roles.copy")}</Link>
                        <Link to="/access/roles/$roleId" params={{ roleId: r.id }} className={buttonClass("ghost")} aria-label={t("access.roles.edit.label", { name: r.name_ko })}>{t("access.roles.edit")}</Link>
                        <Button variant="ghost-danger" aria-label={t("access.roles.delete.label", { name: r.name_ko })} onClick={() => setDeleting(r)}><Trash2 size={16} aria-hidden /></Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </>
        )}
      </QueryState>
      <RoleDelete role={deleting} onClose={() => setDeleting(null)} onDeleted={(m) => (setDeleting(null), setDone(m))} />
    </div>
  );
}
