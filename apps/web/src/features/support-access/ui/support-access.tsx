// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button, Check, Form } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { PageHead } from "../../../ui/page-head/page-head";
import { Table } from "../../../ui/table";
import { codeText } from "../../../lib/labels";
import { buttonClass } from "../../../ui/button/button-class";
import { activeSupportQuery, decideSupportSession, endSupportSession, SUPPORT_READS, supportRefusal, supportSessionsQuery, type Sessions, type SupportDecision, type SupportSession } from "../api";

const scopeText = (scope: string) => scope === "metadata" ? t("supportAccess.scopeMetadata") : codeText(`accessCodes.domain.${scope}`, scope);
const decisionText = (decision: string) => {
  const key = `supportAccess.decision.${decision}`;
  return isMessageId(key) ? t(key) : t("enum.unknown");
};

const stateText = (state:string) => {const key=`supportAccess.state.${state}`;return isMessageId(key)?t(key):t("enum.unknown");};

/** Visible on every tenant page; the shell's SSE stream invalidates this read. */
export function ActiveSupportBanner() {
  const q = useQuery(activeSupportQuery);
  if (q.error) return <CommandError error={q.error} own={supportRefusal}><Button onClick={() => void q.refetch()}>{t("common.retry")}</Button></CommandError>;
  if (!q.data?.sessions.length) return null;
  return <Banner placement="page" tone="warn" live="polite" title={t("supportAccess.banner")}
    actions={<Link to="/audit/support-access" className={buttonClass()}>{t("supportAccess.bannerAction")}</Link>}>
    {q.data.sessions.map((s) => <p key={s.id}>{s.operator_label} · {t("supportAccess.bannerExpiry", { at: s.expires_at ? fmtDateTime(s.expires_at) : "—" })}</p>)}
  </Banner>;
}

export function SupportAccess() {
  const q = useQuery(supportSessionsQuery);
  return <div className="page">
    <PageHead title={t("supportAccess.title")} sub={t("supportAccess.description")} />
    <Card flush>
      <QueryState q={q} own={supportRefusal} empty={(data) => !data.sessions.length ? <EmptyState title={t("supportAccess.emptyTitle")} reason={t("supportAccess.emptyReason")} /> : null}>
        {(data) => <SessionsList data={data} />}
      </QueryState>
    </Card>
  </div>;
}

function SessionsList({ data }: { data: Sessions }) {
  const [selected, setSelected] = useState<string>();
  const current = data.sessions.find((s) => s.id === selected)?.id ?? data.sessions[0]?.id;
  return <Table label={t("supportAccess.title")} rows={data.sessions} rowId={(s) => s.id} selected={current} onSelect={setSelected}
    columns={[
      { header: t("supportAccess.operator"), cell: (s) => <>{s.operator_label}<div className="muted">{s.ticket_ref}</div></> },
      { header: t("supportAccess.state"), cell: (s) => <Chip tone={s.state === "ACTIVE" ? "warn" : "neutral"}>{stateText(s.state)}</Chip> },
      { header: t("supportAccess.reason"), cell: (s) => s.reason, wide: true },
      { header: t("supportAccess.requestedAt"), cell: (s) => fmtDateTime(s.requested_at), wide: true },
    ]}
    detail={(s) => s.id === current ? <SessionDetails key={s.id} session={s} canApprove={data.can_approve} /> : null}
  />;
}

function SessionDetails({ session: s, canApprove }: { session: SupportSession; canApprove: boolean }) {
  const [duration, setDuration] = useState(String(s.requested_duration_seconds));
  const [reveal, setReveal] = useState(false);
  const [tried, setTried] = useState(false);
  const validDuration = Number.isSafeInteger(Number(duration)) && Number(duration) > 0 && Number(duration) <= s.requested_duration_seconds;
  const decide = useCommand({
    run: (body: SupportDecision, key: string) => decideSupportSession(s.id, body, key),
    invalidates: SUPPORT_READS, settle: true, announce: () => t("supportAccess.decisionSaved"),
  });
  const end = useCommand({
    run: (_: void, key: string) => endSupportSession(s.id, key),
    invalidates: SUPPORT_READS, settle: true, announce: () => t("supportAccess.ended"),
  });
  const busy = decide.isPending || end.isPending;
  return <div className="form">
    <KeyValue items={[
      { key: "ticket", label: t("supportAccess.ticket"), value: s.ticket_ref },
      { key: "reason", label: t("supportAccess.reason"), value: <>{s.reason} <span className="muted">({s.reason_code})</span></> },
      { key: "scope", label: t("supportAccess.scope"), value: <>{s.scope.map(scopeText).join(" · ")} · {t("supportAccess.readOnly")}</> },
      { key: "requested", label: t("supportAccess.requestedDuration"), value: t("supportAccess.durationSeconds", { count: s.requested_duration_seconds }) },
      { key: "approved", label: t("supportAccess.approvedDuration"), value: s.approved_duration_seconds == null ? "—" : t("supportAccess.durationSeconds", { count: s.approved_duration_seconds }) },
      { key: "request_expiry", label: t("supportAccess.requestExpiresAt"), value: fmtDateTime(s.request_expires_at) },
      { key: "expiry", label: t("supportAccess.expiresAt"), value: s.expires_at ? fmtDateTime(s.expires_at) : "—" },
    ]} />
    <p>{t(s.masked ? "supportAccess.masked" : "supportAccess.unmasked")}</p>
    {canApprove && s.state === "OPERATOR_APPROVED" && !s.tenant_approved_at && <Form className="form" noValidate onSubmit={() => {
      setTried(true);
      if (validDuration) decide.mutate({ decision: "APPROVE", approved_duration_seconds: Number(duration), reveal_classes: reveal ? ["personal"] : [] });
    }}>
      <p>{t("supportAccess.approvalHint")}</p>
      <Field label={t("supportAccess.approvedDuration")} required hint={t("supportAccess.durationSeconds", { count: s.requested_duration_seconds })} error={tried && !validDuration ? t("supportAccess.durationInvalid") : undefined}>
        {(p) => <TextInput {...p} type="number" min={1} max={s.requested_duration_seconds} step={1} value={duration} onChange={(e) => setDuration(e.target.value)} />}
      </Field>
      <Check checked={reveal} onChange={setReveal}>{t("supportAccess.revealPersonal")}</Check>
      <p className="muted">{t("supportAccess.revealHint")}</p>
      <div className="form__actions">
        <Button variant="primary" type="submit" disabled={busy}>{t("supportAccess.approve")}</Button>
        <Button variant="danger" disabled={busy} onClick={() => decide.mutate({ decision: "DENY", approved_duration_seconds: s.requested_duration_seconds, reveal_classes: [] })}>{t("supportAccess.deny")}</Button>
      </div>
    </Form>}
    {canApprove && (s.state === "ACTIVE" || (s.state === "OPERATOR_APPROVED" && s.tenant_approved_at)) && <Button variant="danger" disabled={busy} onClick={() => end.mutate(undefined)}>{t("supportAccess.end")}</Button>}
    <CommandError error={decide.error ?? end.error} own={supportRefusal} />
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
  </div>;
}
