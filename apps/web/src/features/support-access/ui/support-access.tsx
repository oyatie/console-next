// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button, Check } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { Table } from "../../../ui/table";
import { SidePanel } from "../../../ui/side-panel/side-panel";
import { Composer } from "../../../ui/composer/composer";
import { commitLabel } from "../../../ui/composer/actions";
import { codeText, SUPPORT_SESSION_STATE } from "../../../lib/labels";
import { EnumValue } from "../../../ui/enum-value";
import { ApiError, decideSupportSession, endSupportSession, session, SUPPORT_READS, supportRefusal, supportSessionsQuery, type Sessions, type SupportDecision, type SupportSession } from "../../../reference/support-access/api";

const route = getRouteApi("/app/audit/support-access");
const durationText = (seconds: number) => t("supportAccess.duration", { hours: fmtNumber(Math.floor(seconds / 3600)), minutes: fmtNumber((seconds % 3600) / 60) });
const scopeText = (scope: string) => scope === "metadata" ? t("supportAccess.scopeMetadata") : codeText(`accessCodes.domain.${scope}`, scope);
const decisionText = (decision: string) => {
  const key = `supportAccess.decision.${decision}`;
  return isMessageId(key) ? t(key) : t("enum.unknown");
};

export function SupportAccess() {
  const q = useQuery({ ...supportSessionsQuery, enabled: !!session.token });
  const visible = q.error instanceof ApiError && q.error.status === 403 ? { ...q, data: undefined } : q;
  return <Page floorplan="P-01" head={{ title: t("supportAccess.title") }} q={visible} own={supportRefusal}>
    {data => data.sessions.length ? <SessionsList data={data} /> : <Card flush label={t("supportAccess.description")}>
      <EmptyState title={t("supportAccess.emptyTitle")} reason={t("supportAccess.emptyReason")} />
    </Card>}
  </Page>;
}

function SessionsList({ data }: { data: Sessions }) {
  const { review } = route.useSearch();
  const navigate = route.useNavigate();
  const current = review ? data.sessions.find((s) => s.id === review) : undefined;
  const select = (id?: string) => {
    void navigate({ search: { review: id }, replace: true, resetScroll: false });
  };
  return <div className="split" data-open={Boolean(current)}>
    <Card flush label={t("supportAccess.description")}>
      <Table label={t("supportAccess.title")} rows={data.sessions} rowId={(s) => s.id} selected={current?.id} onSelect={select}
        columns={[
          { header: t("supportAccess.operator"), cell: (s) => <>{s.operator_label}<div className="muted">{s.ticket_ref}</div></> },
          { header: t("supportAccess.state"), cell: (s) => <EnumValue e={SUPPORT_SESSION_STATE} value={s.state} /> },
          { header: t("supportAccess.reason"), cell: (s) => s.reason, wide: true },
          { header: t("supportAccess.requestedAt"), cell: (s) => fmtDateTime(s.requested_at), wide: true },
        ]}
      />
    </Card>
    {current && <SessionDetails key={current.id} session={current} canApprove={data.can_approve} onClose={() => select()} />}
  </div>;
}

function SessionDetails({ session: s, canApprove, onClose }: { session: SupportSession; canApprove: boolean; onClose: () => void }) {
  const [duration, setDuration] = useState(String(s.requested_duration_seconds / 60));
  const [reveal, setReveal] = useState(false);
  const [tried, setTried] = useState(false);
  const validDuration = Number.isSafeInteger(Number(duration) * 60) && Number(duration) > 0 && Number(duration) * 60 <= s.requested_duration_seconds;
  const decide = useCommand({
    run: (body: SupportDecision, key: string) => decideSupportSession(s.id, body, key),
    invalidates: SUPPORT_READS, settle: true, announce: () => t("supportAccess.decisionSaved"),
  });
  const end = useCommand({
    run: (_: void, key: string) => endSupportSession(s.id, key),
    invalidates: SUPPORT_READS, settle: true, announce: () => t("supportAccess.ended"),
  });
  const busy = decide.isPending || end.isPending;
  const approval = canApprove && s.state === "OPERATOR_APPROVED" && !s.tenant_approved_at;
  const terminable = canApprove && (s.state === "ACTIVE" || (s.state === "OPERATOR_APPROVED" && !!s.tenant_approved_at));
  const error = decide.error ?? end.error;
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) notice.current?.focus({ preventScroll: true }); }, [error, approval, terminable]);
  const refusal = error && <div ref={notice} tabIndex={-1}><CommandError error={error} own={supportRefusal} /></div>;
  const content = <>
    <KeyValue items={[
      { key: "operator", label: t("supportAccess.operator"), value: s.operator_label },
      { key: "reason", label: t("supportAccess.reason"), value: <>{s.reason} <span className="muted">({s.reason_code})</span></> },
      { key: "scope", label: t("supportAccess.scope"), value: <>{s.scope.map(scopeText).join(" · ")} · {t("supportAccess.readOnly")} · {t(s.masked ? "supportAccess.masked" : "supportAccess.unmasked")}</> },
      { key: "requested", label: t("supportAccess.requestedDuration"), value: durationText(s.requested_duration_seconds) },
      { key: "approved", label: t("supportAccess.approvedDuration"), value: s.approved_duration_seconds == null ? "—" : durationText(s.approved_duration_seconds) },
      ...(["REQUESTED", "OPERATOR_APPROVED"].includes(s.state) ? [{ key: "request_expiry", label: t("supportAccess.requestExpiresAt"), value: fmtDateTime(s.request_expires_at) }] : []),
      { key: "expiry", label: t("supportAccess.expiresAt"), value: s.expires_at ? fmtDateTime(s.expires_at) : "—" },
    ]} />
    {approval && <>
      <Field label={t("supportAccess.durationMinutes")} required hint={durationText(s.requested_duration_seconds)} error={tried && !validDuration ? t("supportAccess.durationInvalid") : undefined}>
        {(p) => <TextInput {...p} type="number" min={0} max={s.requested_duration_seconds / 60} step="any" value={duration} onChange={(e) => setDuration(e.target.value)} />}
      </Field>
      <Check checked={reveal} onChange={setReveal}>{t("supportAccess.revealPersonal")}</Check>
      <p className="muted">{t("supportAccess.revealHint")}</p>
    </>}
    <h3>{t("supportAccess.decisions")}</h3>
    {s.decisions.length ? <Table label={t("supportAccess.decisions")} rows={s.decisions} rowId={(d) => `${d.at}:${d.actor_label}:${d.decision}`} columns={[
      { header: t("supportAccess.actor"), cell: (d) => d.actor_label },
      { header: t("supportAccess.decision"), cell: (d) => decisionText(d.decision) },
      { header: t("supportAccess.at"), cell: (d) => fmtDateTime(d.at) },
    ]} /> : <p className="muted">{t("supportAccess.noDecisions")}</p>}
    <h3>{t("supportAccess.records")}</h3>
    {s.records.length ? <Table label={t("supportAccess.records")} rows={s.records} rowId={(r) => r.id} columns={[
      { header: t("supportAccess.method"), cell: (r) => r.method },
      { header: t("supportAccess.path"), cell: (r) => r.path },
      { header: t("supportAccess.at"), cell: (r) => fmtDateTime(r.at) },
    ]} /> : <p className="muted">{t("supportAccess.noRecords")}</p>}
  </>;
  return approval || terminable ? <Composer open title={s.ticket_ref} kicker={t(approval ? "supportAccess.approve" : "supportAccess.end")}
    action={{ kind: approval ? "supportAccess" : "support", mode: approval ? "approve" : "end" }} tone={approval ? "primary" : "danger"}
    onClose={onClose} pending={busy} consequence={t(approval ? "supportAccess.approvalHint" : "supportAccess.endConsequence")} notice={refusal}
    secondary={approval && <Button variant="danger" disabled={busy} onClick={() => decide.mutate({ decision: "DENY", approved_duration_seconds: s.requested_duration_seconds, reveal_classes: [] })}>{commitLabel({ kind: "supportAccess", mode: "reject" })}</Button>}
    onSubmit={() => {
      if (approval) {
        setTried(true);
        if (!validDuration) return false;
        decide.mutate({ decision: "APPROVE", approved_duration_seconds: Number(duration) * 60, reveal_classes: reveal ? ["personal"] : [] });
      } else if (terminable) end.mutate(undefined);
    }}
  >
    {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 requires keyboard access to the read-only sheet scroll content. */}
    <section aria-label={t("supportAccess.description")} tabIndex={0}>{content}</section>
  </Composer> : <SidePanel open title={s.ticket_ref} crumb={t("supportAccess.ticket")} onClose={onClose}
    returnFocus={() => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(s.id)}"]`)}
  >{refusal}{content}</SidePanel>;
}
