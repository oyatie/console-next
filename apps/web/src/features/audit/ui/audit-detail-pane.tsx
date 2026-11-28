// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { lifecycleTarget } from "../present";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Banner } from "../../../ui/banner/banner";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { buildSnapDiffRows } from "../present";
import type { AuditRecord } from "../api";
import s from "./audit.module.css";

type AttestationLike = { ok: boolean; unsealed_tail: boolean; kind: string } | null | undefined;

export function AuditDetailPane({
  selected,
  attestation,
  outcomeLabel,
  sourceLabel,
}: {
  selected: AuditRecord;
  attestation?: AttestationLike;
  outcomeLabel: string;
  sourceLabel: string;
}) {
  const diffRows = buildSnapDiffRows(selected.before_snap, selected.after_snap);
  const target = lifecycleTarget(selected.target_type, selected.target_id);
  return (
    <div className={s.paneDetail}>
      <RecordIdentityBar
        name={selected.actor_display ?? selected.actor ?? "—"}
        badges={<Chip tone={selected.anomaly ? "warn" : selected.outcome === "DENIED" ? "danger" : "ok"}>{outcomeLabel}</Chip>}
        roleLine={fmtDateTime(selected.occurred_at)}
        path={selected.action ? <code translate="no" className="mono t-xs muted">{selected.action}</code> : undefined}
      />
      <RecordPaneSection title={t("audit.detail.title")}>
        <KeyValue
          density="dense"
          items={[
            { key: "id", label: t("audit.detail.id"), value: selected.id ?? "—" },
            { key: "target", label: t("audit.log.col.target"), value: [selected.target_type, selected.target_id].filter(Boolean).join(" · ") || "—" },
            { key: "source", label: t("audit.log.col.source"), value: sourceLabel },
            { key: "trace", label: t("audit.detail.trace"), value: [selected.trace_id, selected.span_id].filter(Boolean).join(" / ") || "—" },
            { key: "branch", label: t("audit.detail.branch"), value: selected.branch_id ?? "—" },
            { key: "auth", label: t("audit.detail.auth"), value: [selected.auth_method, selected.device].filter(Boolean).join(" · ") || "—" },
            { key: "ip", label: t("audit.detail.ip"), value: selected.ip ?? "—" },
            { key: "reason", label: t("audit.detail.reason"), value: [selected.reason_code, selected.reason].filter(Boolean).join(" · ") || "—" },
            { key: "badges", label: t("audit.detail.badges"), value: selected.classification_badges?.length ? selected.classification_badges.join(" · ") : "—" },
          ]}
        />
      </RecordPaneSection>
      {target && <LifecycleLink target={target} />}
      {attestation && (
        <RecordPaneSection title={t("audit.detail.attestation")}>
          <Banner
            tone={attestation.ok ? (attestation.unsealed_tail ? "warn" : "ok") : "danger"}
            title={
              attestation.ok
                ? t(attestation.unsealed_tail ? "audit.attestation.unsealed" : "audit.attestation.ok")
                : t("audit.attestation.tampered", { kind: attestation.kind })
            }
          />
        </RecordPaneSection>
      )}
      <RecordPaneSection title={t("audit.detail.diff")}>
        {diffRows.length ? <KeyValue density="dense" items={diffRows} /> : <EmptyState title={t("audit.detail.noSnap")} reason={null} />}
      </RecordPaneSection>
    </div>
  );
}


function LifecycleLink({ target }: { target: NonNullable<ReturnType<typeof lifecycleTarget>> }) {
  const allowed = useServedCapability("lifecycle_manage");
  return allowed ? <Link to="/audit/lifecycles/$objectType/$objectId" params={target}>{t("audit.lifecycle.open")}</Link> : null;
}
