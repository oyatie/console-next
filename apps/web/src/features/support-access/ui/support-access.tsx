// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
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
import { ApiError, activeSupportQuery, decideSupportSession, endSupportSession, SUPPORT_READS, supportRefusal, supportSessionsQuery, type Sessions, type SupportDecision, type SupportSession } from "../../../reference/support-access/api";
import styles from "./support-access.module.css";

const route = getRouteApi("/app/audit/support-access");
const durationText = (seconds: number) => t("supportAccess.duration", { hours: fmtNumber(Math.floor(seconds / 3600)), minutes: fmtNumber((seconds % 3600) / 60) });
const scopeText = (scope: string) => scope === "metadata" ? t("supportAccess.scopeMetadata") : codeText(`accessCodes.domain.${scope}`, scope);
const decisionText = (decision: string) => {
  const key = `supportAccess.decision.${decision}`;
  return isMessageId(key) ? t(key) : t("enum.unknown");
};

const stateText = (state:string) => {const key=`supportAccess.state.${state}`;return isMessageId(key)?t(key):t("enum.unknown");};

/** Visible on every tenant page; the shell's SSE stream invalidates this read. */
export function ActiveSupportBanner() {
  const q = useQuery(activeSupportQuery);
  if (!q.error && (!q.data || (!q.data.sessions.length && !(q.data.can_approve && q.data.pending_count)))) return null;
  return <section className={styles.status} aria-label={t("supportAccess.title")}>
    {q.error ? <CommandError error={q.error} own={supportRefusal}><Button onClick={() => void q.refetch()}>{t("common.retry")}</Button></CommandError> : q.data && <>
    {q.data.can_approve && q.data.pending_count > 0 && <Banner placement="page" tone="warn" live="polite" title={t("supportAccess.pending", { count: fmtNumber(q.data.pending_count) })}
      actions={<Link to="/audit/support-access" search={{ review: q.data.pending_approvals[0]?.id }} className={buttonClass()}>{t("supportAccess.review")}</Link>}>
      {q.data.pending_approvals.map((s) => <p key={s.id}>{s.operator_label} · {t("supportAccess.requestDeadline", { at: fmtDateTime(s.request_expires_at) })}</p>)}
    </Banner>}
    {q.data.sessions.length > 0 && <Banner placement="page" tone="warn" live="polite" title={t("supportAccess.banner")}
      actions={q.data.can_approve ? <Link to="/audit/support-access" className={buttonClass()}>{t("supportAccess.bannerAction")}</Link> : undefined}>
      {q.data.sessions.map((s) => <p key={s.id}>{s.operator_label} · {t("supportAccess.bannerExpiry", { at: s.expires_at ? fmtDateTime(s.expires_at) : "—" })}</p>)}
    </Banner>}
    </>}
  </section>;
}

/** The shell header keeps this visible while the page's detailed notice scrolls. */
export function SupportAccessIndicator() {
  const q = useQuery(activeSupportQuery);
  if (q.error || !q.data) return null;
  const active = q.data.sessions.length;
  const pending = q.data.can_approve ? q.data.pending_count : 0;
  if (!active && !pending) return null;
  const label = t("supportAccess.indicatorLabel", { pending: fmtNumber(pending), active: fmtNumber(active) });
  const count = <Chip tone="warn">{t("supportAccess.indicator", { count: fmtNumber(active + pending) })}</Chip>;
  return q.data.can_approve
    ? <Link to="/audit/support-access" className={styles.indicator} aria-label={label} title={label}>{count}</Link>
    : <span className={styles.indicator} role="status" aria-label={label} title={label}>{count}</span>;
}

export function SupportAccess() {
  const q = useQuery(supportSessionsQuery);
  const visible = q.error instanceof ApiError && q.error.status === 403 ? { ...q, data: undefined } : q;
  return <div className="page">
    <PageHead title={t("supportAccess.title")} sub={t("supportAccess.description")} />
    <Card flush>
      <QueryState q={visible} own={supportRefusal} empty={(data) => !data.sessions.length ? <EmptyState title={t("supportAccess.emptyTitle")} reason={t("supportAccess.emptyReason")} /> : null}>
        {(data) => <SessionsList data={data} />}
      </QueryState>
    </Card>
  </div>;
}

function SessionsList({ data }: { data: Sessions }) {
  const { review } = route.useSearch();
  const navigate = route.useNavigate();
  const current = data.sessions.find((s) => s.id === review)?.id ?? data.sessions[0]?.id;
  return <Table label={t("supportAccess.title")} rows={data.sessions} rowId={(s) => s.id} selected={current} onSelect={(id) => void navigate({ search: { review: id }, replace: true })}
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
  return <div className="form">
    <KeyValue items={[
      { key: "ticket", label: t("supportAccess.ticket"), value: s.ticket_ref },
      { key: "reason", label: t("supportAccess.reason"), value: <>{s.reason} <span className="muted">({s.reason_code})</span></> },
      { key: "scope", label: t("supportAccess.scope"), value: <>{s.scope.map(scopeText).join(" · ")} · {t("supportAccess.readOnly")}</> },
      { key: "requested", label: t("supportAccess.requestedDuration"), value: durationText(s.requested_duration_seconds) },
      { key: "approved", label: t("supportAccess.approvedDuration"), value: s.approved_duration_seconds == null ? "—" : durationText(s.approved_duration_seconds) },
      ...(["REQUESTED", "OPERATOR_APPROVED"].includes(s.state) ? [{ key: "request_expiry", label: t("supportAccess.requestExpiresAt"), value: fmtDateTime(s.request_expires_at) }] : []),
      { key: "expiry", label: t("supportAccess.expiresAt"), value: s.expires_at ? fmtDateTime(s.expires_at) : "—" },
    ]} />
    <p>{t(s.masked ? "supportAccess.masked" : "supportAccess.unmasked")}</p>
    {canApprove && s.state === "OPERATOR_APPROVED" && !s.tenant_approved_at && <Form className="form" noValidate onSubmit={() => {
      setTried(true);
      if (validDuration) decide.mutate({ decision: "APPROVE", approved_duration_seconds: Number(duration) * 60, reveal_classes: reveal ? ["personal"] : [] });
    }}>
      <p>{t("supportAccess.approvalHint")}</p>
      <Field label={t("supportAccess.durationMinutes")} required hint={durationText(s.requested_duration_seconds)} error={tried && !validDuration ? t("supportAccess.durationInvalid") : undefined}>
        {(p) => <TextInput {...p} type="number" min={0} max={s.requested_duration_seconds / 60} step="any" value={duration} onChange={(e) => setDuration(e.target.value)} />}
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
