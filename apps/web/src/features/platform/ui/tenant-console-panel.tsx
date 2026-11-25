// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { TENANT_LIFECYCLE, TENANT_STATUS } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { useOnline } from "../../../lib/react/use-online";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EnumValue } from "../../../ui/enum-value";
import { KeyValue, type KeyValueItem } from "../../../ui/key-value/key-value";
import { RecordIdentityBar, RecordPaneGroup, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { eraseQuery, recoveryQuery, supportSessionsQuery, type EraseRead, type Health, type Issued, type OpsRecoveryRead, type Org, type Recorded } from "../api";
import { MOVES, type Move } from "../domain/tenants";
import { DomainDialog } from "./domain-dialog";
import { OpsRecovery } from "./ops-recovery";
import { Reissue } from "./reissue";
import { RemoveDialog } from "./remove-dialog";
import { StatusDialog } from "./status-dialog";
import { EraseControls, type EraseRenderSlots } from "./tenant-erase";
import s from "./platform-console.module.css";

/** A tenant with no recovery under way: its sections hold the room while the recovery read is out. */
const NO_RECOVERY: OpsRecoveryRead = { request: null, state: null, recovery_available: false, ops_has_passkey: false, ops_enrolled: false,
  second_operator_available: true, active_accounts: 0, hold_hours: 24, code_ttl_minutes: 10 };

export function TenantConsolePanel({
  org,
  health,
  onIssued,
  onRecorded,
  onRemoved,
  onOpenSupport,
}: {
  org: Org;
  health: Health | undefined;
  onIssued: (r: Issued) => void;
  onRecorded: (r: Recorded) => void;
  onRemoved: (r: Recorded) => void;
  onOpenSupport: (orgId: string) => void;
}) {
  const recovery = useQuery(recoveryQuery(org.id));
  const erase = useQuery(eraseQuery(org.id));
  const support = useQuery({ ...supportSessionsQuery(org.id), enabled: org.status === "ACTIVE", retry: false });
  const eraseView = queryView(erase);
  const answered = recovery.data !== undefined && ["ready", "stale", "offline"].includes(queryView(recovery));
  const online = useOnline();
  const [domainOpen, setDomainOpen] = useState(false);
  const [move, setMove] = useState<Move | null>(null);
  const [removing, setRemoving] = useState<"guarded" | null>(null);

  const archive = () => {
    setRemoving(null);
    setMove("archive");
  };
  const removed = (r: Recorded) => {
    setRemoving(null);
    onRemoved(r);
  };

  const hasHealthStats = Boolean(
    health && (health.user_count > 0 || health.open_work_orders > 0 || health.zero_legacy_release_cycles > 0),
  );
  const overviewItems: KeyValueItem[] = [
    ...(org.pending_domain ? [{ key: "pending", label: t("account.domain.requested"), value: <code>{org.pending_domain}</code> }] : []),
    ...(org.group_name ? [{ key: "group", label: t("tenants.col.group"), value: org.group_name }] : []),
    { key: "created", label: t("tenants.panel.created"), value: <bdi className="num">{fmtDateTime(org.created_at)}</bdi> },
    { key: "updated", label: t("tenants.panel.updated"), value: <bdi className="num">{fmtDateTime(org.updated_at)}</bdi> },
    ...(org.passkey_registered_count !== undefined
      ? [{
          key: "users",
          label: t("tenants.col.users"),
          value: (
            <bdi className="num">
              {health
                ? t("tenants.panel.users", { active: org.passkey_registered_count, total: health.user_count })
                : t("tenants.panel.active", { active: org.passkey_registered_count })}
            </bdi>
          ),
        }]
      : []),
    ...(org.code_issued_count !== undefined
      ? [{ key: "issued", label: t("tenants.accounts.codeIssued"), value: <bdi className="num">{fmtNumber(org.code_issued_count)}</bdi> }]
      : []),
    ...(health?.last_activity_at
      ? [{ key: "activity", label: t("tenants.col.activity"), value: <bdi className="num">{fmtDateTime(health.last_activity_at)}</bdi> }]
      : []),
    ...(hasHealthStats && health
      ? [
          { key: "work", label: t("tenants.panel.healthWorkOrders"), value: <bdi className="num">{fmtNumber(health.open_work_orders)}</bdi> },
          { key: "legacy", label: t("tenants.panel.healthZeroLegacy"), value: <bdi className="num">{fmtNumber(health.zero_legacy_release_cycles)}</bdi> },
        ]
      : []),
  ];

  const recoveryState = <QueryState q={recovery} compact failedTitle={t("tenants.recoveryFailed")}>{() => null}</QueryState>;
  const recoverySections = (data: OpsRecoveryRead) => <>
    {org.status === "ACTIVE" ? <RecordPaneSection title={t("tenants.section.code")}>
      <Reissue embedded org={org} enrolled={data.ops_enrolled} onEnrolled={() => void recovery.refetch()} onIssued={onIssued} />
    </RecordPaneSection> : null}
    <RecordPaneSection title={t("opsRecovery.title")}><OpsRecovery embedded org={org} data={data} onIssued={onIssued} /></RecordPaneSection>
  </>;

  const moves = MOVES[org.status].filter((m) => m !== "archive" || org.removable === true);
  const supportSessions = support.data?.sessions ?? [];
  const activeSupport = supportSessions.filter((item) => item.state === "ACTIVE").length;

  return (
    <div className={s.paneSections}>
      <RecordIdentityBar
        name={org.name}
        number={<code>{org.slug}</code>}
        badges={
          <>
            <EnumValue e={TENANT_STATUS} value={org.status} />
            {org.lifecycle ? <EnumValue e={TENANT_LIFECYCLE} value={org.lifecycle} /> : null}
          </>
        }
        actions={
          <div className={s.actionRow}>
            <Button size="sm" variant="secondary" onClick={() => setDomainOpen(true)}>
              {t("tenants.domain.change")}
            </Button>
            {org.status === "ACTIVE" ? (
              <Button size="sm" variant="secondary" onClick={() => onOpenSupport(org.id)}>
                {t("tenants.panel.supportOpen")}
              </Button>
            ) : null}
            {moves.map((m) => (
              <Button key={m} size="sm" variant="secondary" onClick={() => setMove(m)}>
                {t(`tenants.status.${m}`, { org: org.name })}
              </Button>
            ))}
          </div>
        }
      />

      <RecordPaneSection title={t("tenants.panel.overview")}>
        <KeyValue density="dense" items={overviewItems} />
      </RecordPaneSection>

      {/* One read fills both sections: until it answers, its loading or failure shows once over room held for a new tenant's
          answer, and that room stays (an established tenant's answer is shorter), so deletion moves only for a taller answer
          or refusal. Offline, the page's own notice says so. */}
      <RecordPaneGroup held={!answered} className={s.readSlot}>
        {answered && recovery.data ? <>
          <div className={s.readState}>{online ? recoveryState : null}</div>
          {recoverySections(recovery.data)}
        </> : <div className={s.readHold}>
          <div className={s.readPlaceholder} aria-hidden inert>{recoverySections(NO_RECOVERY)}</div>
          <div className={s.readState}>{recoveryState}</div>
        </div>}
      </RecordPaneGroup>

      {org.status === "ACTIVE" && supportSessions.length > 0 ? (
        <RecordPaneSection
          title={t("tenants.panel.support")}
          trailing={
            <Button size="sm" variant="ghost" onClick={() => onOpenSupport(org.id)}>
              {t("tenants.panel.supportOpen")}
            </Button>
          }
        >
          <KeyValue
            density="dense"
            items={[
              {
                key: "sessions",
                label: t("tenants.panel.support"),
                value: activeSupport > 0
                  ? `${t("tenants.panel.supportCount", { count: supportSessions.length })} · ${t("tenants.panel.supportActive", { count: activeSupport })}`
                  : t("tenants.panel.supportCount", { count: supportSessions.length }),
              },
            ]}
          />
        </RecordPaneSection>
      ) : null}

      <RecordPaneSection title={t("tenants.section.remove")}>
        <div className={s.paneInner}>
          <bdi className="muted t-sm">{t("tenants.remove.consequence")}</bdi>
          <RemoveAndEraseRow
            org={org}
            eraseData={erase.data}
            eraseView={eraseView}
            eraseError={Boolean(erase.error)}
            onRemove={() => setRemoving("guarded")}
            onArchive={archive}
          />
          {online || erase.data === undefined ? <QueryState q={erase} loading={null} failedTitle={t("tenants.eraseFailed")}>{() => null}</QueryState> : null}
        </div>
      </RecordPaneSection>

      {domainOpen ? (
        <DomainDialog
          org={org}
          onClose={() => setDomainOpen(false)}
          onDone={(r) => {
            setDomainOpen(false);
            onRecorded(r);
          }}
        />
      ) : null}
      <StatusDialog
        org={org}
        move={move}
        onClose={() => setMove(null)}
        onDone={(r) => {
          setMove(null);
          onRecorded(r);
        }}
      />
      <RemoveDialog
        org={org}
        open={removing === "guarded"}
        onClose={() => setRemoving(null)}
        onDone={removed}
        onArchive={archive}
      />
    </div>
  );
}

function RemoveAndEraseRow({
  org,
  eraseData,
  eraseView,
  eraseError,
  onRemove,
  onArchive,
}: {
  org: Org;
  eraseData: EraseRead | undefined;
  eraseView: string;
  eraseError: boolean;
  onRemove: () => void;
  onArchive: () => void;
}) {
  const renderRow = (removeControl: ReactNode, removeReason: ReactNode, eraseSlots: EraseRenderSlots) => (
    <>
      {eraseSlots.banner}
      <div className={s.actionRow}>
        {removeControl}
        {eraseSlots.controls}
      </div>
      {removeReason || eraseSlots.reasons ? (
        <div className={s.reasonStack}>
          {removeReason}
          {eraseSlots.reasons}
        </div>
      ) : null}
      {eraseSlots.dialog}
    </>
  );

  const renderWithRemove = (eraseSlots: EraseRenderSlots) =>
    org.removable === true ? (
      renderRow(
        <Button size="sm" onClick={onRemove}>
          {t("tenants.remove", { org: org.name })}
        </Button>,
        null,
        eraseSlots,
      )
    ) : (
      <DisabledReason
        control={(p) => (
          <Button size="sm" {...p}>
            {t("tenants.remove", { org: org.name })}
          </Button>
        )}
        reason={t(
          org.removal_refusal === "blocked_legal_hold"
            ? "tenants.remove.legalHold"
            : org.removal_refusal === "tenant_has_data"
              ? "tenants.remove.hasData"
              : "tenants.remove.checking",
          { org: org.name },
        )}
        remedy={
          org.status !== "ARCHIVED" ? (
            <Button size="sm" variant="ghost" onClick={onArchive}>
              {t("tenants.status.archive", { org: org.name })}
            </Button>
          ) : undefined
        }
      >
        {({ control, reason }) => renderRow(control, reason, eraseSlots)}
      </DisabledReason>
    );

  if (eraseData !== undefined && ["ready", "stale", "offline"].includes(eraseView)) {
    return (
      <EraseControls org={org} data={eraseData} size="sm">
        {renderWithRemove}
      </EraseControls>
    );
  }

  return (
    <DisabledReason
      control={(p) => (
        <Button size="sm" {...p}>
          {t("tenants.remove.force", { org: org.name })}
        </Button>
      )}
      reason={t(eraseError ? "common.loadFailed.title" : "common.loading")}
    >
      {({ control, reason }) => renderWithRemove({ banner: null, controls: control, reasons: reason, dialog: null })}
    </DisabledReason>
  );
}
