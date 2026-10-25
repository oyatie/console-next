import { useQuery } from "@tanstack/react-query";
import { recoveryQuery } from "../api";
import { QueryState } from "../../../lib/react/query-state";
import { OpsRecovery } from "./ops-recovery";
import { useState } from "react";
import { X } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { TENANT_STATUS, TENANT_LIFECYCLE, labeled } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import type { Health, Issued, Org, Recorded } from "../api";
import { MOVES, type Move } from "../domain/tenants";
import { TenantErase } from "./tenant-erase";
import { Reissue } from "./reissue";
import { RemoveDialog } from "./remove-dialog";
import { DomainDialog } from "./domain-dialog";
import { StatusDialog } from "./status-dialog";
import s from "./tenants.module.css";

/**
 * One tenant: its facts (the list row plus its usage rollup; there is no detail read) and its lifecycle,
 * offering only the moves its status allows. Slots for later tabs: group, health (route adoption),
 * and approved support access (managed through tenant consent).
 */
export function TenantPanel({ org, health, onIssued, onRecorded, onRemoved, onClose }: {
  org: Org;
  health: Health | undefined;
  onIssued: (r: Issued) => void;
  onRecorded: (r: Recorded) => void;
  onRemoved: (r: Recorded) => void;
  onClose: () => void;
}) {
  const recovery = useQuery(recoveryQuery(org.id));
  const [domainOpen, setDomainOpen] = useState(false);
  const [move, setMove] = useState<Move | null>(null);
  const [removing, setRemoving] = useState<"guarded" | null>(null);
  const st = labeled(TENANT_STATUS, org.status);
  // The removal dialogs hand over to the archive dialog when archiving is the way through.
  const archive = () => {
    setRemoving(null);
    setMove("archive");
  };
  const removed = (r: Recorded) => {
    setRemoving(null);
    onRemoved(r);
  };
  return (
    <aside className="card panel" aria-labelledby="tenant-title">
      <div className="panel__head">
        <h2 id="tenant-title" className="panel__title" tabIndex={-1}>{org.name}</h2>
        <Chip tone={st.tone}>{st.label}</Chip>
        {org.lifecycle && <Chip tone={labeled(TENANT_LIFECYCLE, org.lifecycle).tone}>{labeled(TENANT_LIFECYCLE, org.lifecycle).label}</Chip>}
        <Button variant="ghost" onClick={onClose} aria-label={t("common.closePanel")}><X size={16} aria-hidden /></Button>
      </div>
      <dl className="kv">
        <dt>{t("tenants.col.slug")}</dt><dd className="code">{org.slug}</dd>
        {org.pending_domain && <><dt>{t("account.domain.requested")}</dt><dd className="code">{org.pending_domain}</dd></>}
        <dt>{t("tenants.col.group")}</dt><dd>{org.group_name ?? "—"}</dd>
        <dt>{t("tenants.panel.created")}</dt><dd className="num">{fmtDateTime(org.created_at)}</dd>
        <dt>{t("tenants.panel.updated")}</dt><dd className="num">{fmtDateTime(org.updated_at)}</dd>
        <dt>{t("tenants.col.users")}</dt><dd className="num">{org.passkey_registered_count !== undefined ? health ? t("tenants.panel.users", { active: org.passkey_registered_count, total: health.user_count }) : t("tenants.panel.active", { active: org.passkey_registered_count }) : "—"}</dd>
        {org.code_issued_count !== undefined && <><dt>{t("tenants.accounts.codeIssued")}</dt><dd>{org.code_issued_count}</dd></>}
        <dt>{t("tenants.col.activity")}</dt><dd className="num">{fmtDateTime(health?.last_activity_at)}</dd>
      </dl>

      <Button onClick={() => setDomainOpen(true)}>{t("tenants.domain.change")}</Button>
      {domainOpen && <DomainDialog org={org} onClose={() => setDomainOpen(false)} onDone={(r) => { setDomainOpen(false); onRecorded(r); }} />}
      {/* The server issues a code only for an active tenant. The status and removal sections are drawn once the recovery read has landed
          (or failed): drawn under its skeleton, they moved down under the pointer when it arrived. */}
      <QueryState q={recovery}>{data => <>
        {org.status === "ACTIVE" && <Reissue org={org} enrolled={data.ops_enrolled} onEnrolled={() => { void recovery.refetch(); }} onIssued={onIssued} />}
        <OpsRecovery org={org} data={data} onIssued={onIssued} />
      </>}</QueryState>

      <section className={s.section} aria-labelledby="tenant-status">
        <h3 id="tenant-status" className={s.heading}>{t("tenants.col.status")}</h3>
        <div className={s.actions}>
          {MOVES[org.status].filter(m => m !== "archive" || org.removable === true).map((m) => <Button key={m} onClick={() => setMove(m)}>{t(`tenants.status.${m}`, { org: org.name })}</Button>)}
        </div>
      </section>

      <section className={s.section} aria-labelledby="tenant-remove">
        <h3 id="tenant-remove" className={s.heading}>{t("tenants.section.remove")}</h3>
        <p className={s.note}>{t("tenants.remove.consequence")}</p>
        {org.removable === true ? <Button onClick={() => setRemoving("guarded")}>{t("tenants.remove", { org: org.name })}</Button> : (
          <DisabledReason control={p => <Button {...p}>{t("tenants.remove", { org: org.name })}</Button>}
            reason={t(org.removal_refusal === "blocked_legal_hold" ? "tenants.remove.legalHold" : org.removal_refusal === "tenant_has_data" ? "tenants.remove.hasData" : "tenants.remove.checking", { org: org.name })}
            remedy={org.status !== "ARCHIVED" && <Button variant="ghost" onClick={archive}>{t("tenants.status.archive", { org: org.name })}</Button>} />
        )}
        <TenantErase org={org} />
      </section>

      <StatusDialog
        org={org}
        move={move}
        onClose={() => setMove(null)}
        onDone={(r) => {
          setMove(null);
          onRecorded(r);
        }}
      />
      <RemoveDialog org={org} open={removing === "guarded"} onClose={() => setRemoving(null)} onDone={removed} onArchive={archive} />
    </aside>
  );
}
