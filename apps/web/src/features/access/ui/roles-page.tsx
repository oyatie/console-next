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
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { grantsQuery, rolesQuery, type AccessGrant, type AccessRole } from "../api";
import { linesText } from "../present";
import { AccessHead } from "./access-head";
import { RoleDelete } from "./role-delete";
import s from "./access.module.css";

/** No preset roles: the empty state explains the workflow and opens role creation or bulk grants. */
function NoRoles() {
  return (
    <Card label={t("access.roles.empty.title")} flush>
      <EmptyState
        title={t("access.roles.empty.title")}
        reason={t("access.roles.empty.reason")}
        actions={
          <>
            <Link to="/access/roles/new" className={buttonClass("primary")}>{t("access.roles.create")}</Link>
            <Link to="/access/grants/bulk" className={buttonClass()}>{t("access.bulk.open")}</Link>
          </>
        }
      />
      <div className={s.pad}>
        <ol className={s.steps}>
          <li><b>{t("access.roles.empty.step1.title")}</b>{t("access.roles.empty.step1.body")}</li>
          <li><b>{t("access.roles.empty.step2.title")}</b>{t("access.roles.empty.step2.body")}</li>
          <li><b>{t("access.roles.empty.step3.title")}</b>{t("access.roles.empty.step3.body")}</li>
        </ol>
      </div>
    </Card>
  );
}

/** Holders: the count (opens their grants), marked when every one of their grants waits for go-live. */
function Holders({ r, grants }: { r: AccessRole; grants: readonly AccessGrant[] }) {
  if (!r.holder_count) return <span className="muted">{t("access.people", { count: 0 })}</span>;
  const mine = grants.filter((g) => g.role_id === r.id);
  return (
    <div className={s.actions}>
      <Link className={s.plainLink} to="/access/grants" search={{ role: r.id }}>{t("access.people", { count: r.holder_count })}</Link>
      {mine.length > 0 && mine.every((g) => g.enforcement === "PREPARED") && <Chip tone="info">{t("access.roles.fromGoLive")}</Chip>}
    </div>
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
    <div className="page" data-access-page="">
      <AccessHead failed={Boolean(roles.error)} actions={!roles.error && roles.data?.items.length ? <Link to="/access/roles/new" className={buttonClass("primary")}><Plus size={16} aria-hidden />{t("access.roles.create")}</Link> : undefined} />
<QueryState q={roles} layout="list">{d => <>      {done && <Banner live="polite">{done}</Banner>}
      {d.items.length ? (
          <>
            <Card label={t("access.roles.count", { count: d.items.length })} flush>
              <Table
                label={t("access.roles.count", { count: d.items.length })}
                rows={d.items}
                rowId={(r) => r.id}
                mobileLayout="compact"
                columns={[
                  { card: "fact", rowHeader: true, header: t("access.roles.col.name"), cell: (r) => <Link className={s.plainLink} to="/access/roles/$roleId" params={{ roleId: r.id }}>{r.name_ko}</Link> },
                  { card: "title", header: t("access.roles.col.lines"), cell: (r) => <><span className={`muted ${s.desktopOnly}`}>{linesText(r.lines)}</span><bdi className={s.phoneOnly}>{[linesText(r.lines), t("access.people", { count: r.holder_count })].join(" · ")}</bdi></> },
                  { card: "omit", header: t("access.roles.col.holders"), cell: (r) => <Holders r={r} grants={live} /> },
                  {
                    card: "action",
                    header: <span className="sr-only">{t("access.roles.col.actions")}</span>,
                    cell: (r) => (
                      <div className={s.actions}>
                        <Link to="/access/roles/new" search={{ copy: r.id }} className={buttonClass("ghost", { size: "sm" })} aria-label={t("access.roles.copy.label", { name: r.name_ko })}>{t("access.roles.copy")}</Link>
                        <Link to="/access/roles/$roleId" params={{ roleId: r.id }} className={buttonClass("ghost", { size: "sm" })} aria-label={t("access.roles.edit.label", { name: r.name_ko })}>{t("access.roles.edit")}</Link>
                        <Button size="sm" variant="ghost-danger" aria-label={t("access.roles.delete.label", { name: r.name_ko })} onClick={() => setDeleting(r)}><Trash2 size={16} aria-hidden /></Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </>
        ) : <NoRoles />}
      <RoleDelete role={deleting} onClose={() => setDeleting(null)} onDeleted={(m) => (setDeleting(null), setDone(m))} />
    </>}</QueryState>
    </div>
  );
}
