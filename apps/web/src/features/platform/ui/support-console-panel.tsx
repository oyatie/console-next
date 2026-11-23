// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { SUPPORT_SESSION_STATE, codeText } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { supportRefusal } from "../../../reference/support-access/api";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EnumValue } from "../../../ui/enum-value";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import {
  approveSupportSession,
  endSupportSession,
  startSupportSession,
  type SupportSessionMetadata,
  type SupportStartOutcome,
} from "../api";
import { supportActionEligibility } from "../domain/support";
import s from "./platform-console.module.css";

const scopeText = (scope: string) => codeText(`accessCodes.domain.${scope}`, scope);

export function SupportSessionPanel({
  session,
  currentOperatorId,
  onApproved,
  onStarted,
  onEnded,
}: {
  session: SupportSessionMetadata;
  currentOperatorId?: string;
  onApproved: () => void;
  onStarted: (outcome: SupportStartOutcome) => void;
  onEnded: () => void;
}) {
  const approve = useCommand({
    run: () => approveSupportSession(session.id, session.org_id),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: onApproved,
  });
  const start = useCommand({
    run: () => startSupportSession(session.id, session.org_id),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: onStarted,
  });
  const end = useCommand({
    run: () => endSupportSession(session.id, session.org_id),
    invalidates: ["/api/platform"],
    onSuccess: onEnded,
  });

  const { canApprove, approveRefusal, canStart, startRefusal, canEnd, endRefusal } = supportActionEligibility(
    session,
    currentOperatorId,
  );
  const busy = approve.isPending || start.isPending || end.isPending;
  const error = approve.error ?? start.error ?? end.error;

  return (
    <div className={s.paneStack}>
      <RecordIdentityBar
        name={session.id.slice(0, 8)}
        badges={<EnumValue e={SUPPORT_SESSION_STATE} value={session.state} />}
      />

      <RecordPaneSection title={t("tenants.support.details")}>
        <KeyValue
          density="dense"
          items={[
            {
              key: "scope",
              label: t("tenants.support.col.scope"),
              value: session.scope?.length ? session.scope.map(scopeText).join(" · ") : "—",
            },
            {
              key: "duration",
              label: t("tenants.support.col.duration"),
              value: session.requested_duration_seconds
                ? t("tenants.support.durationMinutes", { minutes: Math.round(session.requested_duration_seconds / 60) })
                : "—",
            },
            {
              key: "consent",
              label: t("tenants.support.col.tenantConsent"),
              value: t(session.tenant_approved ? "tenants.support.consent.yes" : "tenants.support.consent.no"),
            },
            ...(session.operator_approver_ref
              ? [{ key: "approver", label: t("tenants.support.approver"), value: <code>{session.operator_approver_ref.slice(0, 8)}</code> }]
              : []),
            { key: "requested", label: t("tenants.support.col.requested"), value: <bdi className="num">{fmtDateTime(session.requested_at)}</bdi> },
            ...(session.request_expires_at
              ? [{ key: "deadline", label: t("tenants.support.requestDeadline"), value: <bdi className="num">{fmtDateTime(session.request_expires_at)}</bdi> }]
              : []),
            ...(session.expires_at
              ? [{ key: "expires", label: t("tenants.support.col.expires"), value: <bdi className="num">{fmtDateTime(session.expires_at)}</bdi> }]
              : []),
          ]}
        />
      </RecordPaneSection>

      {canApprove || approveRefusal || canStart || startRefusal || canEnd || endRefusal ? (
        <RecordPaneSection title={t("tenants.support.lifecycle")}>
          <div className={s.paneStack}>
            <PasskeyError error={error} own={supportRefusal} />
            <div className={s.actionRow}>
              {canApprove ? (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => approve.mutate(undefined)}>
                  {t("tenants.support.approve")}
                </Button>
              ) : approveRefusal ? (
                <DisabledReason
                  reason={t(approveRefusal)}
                  control={(p) => (
                    <Button size="sm" {...p}>
                      {t("tenants.support.approve")}
                    </Button>
                  )}
                />
              ) : null}

              {canStart ? (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => start.mutate(undefined)}>
                  {t("tenants.support.start")}
                </Button>
              ) : startRefusal ? (
                <DisabledReason
                  reason={t(startRefusal === "requesterOnly" ? "tenants.support.requesterOnly" : startRefusal)}
                  control={(p) => (
                    <Button size="sm" {...p}>
                      {t("tenants.support.start")}
                    </Button>
                  )}
                />
              ) : null}

              {canEnd ? (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => end.mutate(undefined)}>
                  {t("tenants.support.end")}
                </Button>
              ) : endRefusal ? (
                <DisabledReason
                  reason={t("tenants.support.requesterOnly")}
                  control={(p) => (
                    <Button size="sm" {...p}>
                      {t("tenants.support.end")}
                    </Button>
                  )}
                />
              ) : null}
            </div>
          </div>
        </RecordPaneSection>
      ) : null}
    </div>
  );
}
