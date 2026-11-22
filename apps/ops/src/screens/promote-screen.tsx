// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsPromote, OpsApiError, opsQueryKeys, readObservedValue, type OpsPromoteView } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtColon, formatFeedbackDisposition, formatPromoteVerdict, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useOpsContext } from "../lib/ops-context";
import { Badge, type BadgeTone } from "../ui/badge";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { StatRow } from "../ui/stat-row";
import { buildRunningTabs } from "./hub-tabs";
import { PromoteForms } from "./promote-forms";
import s from "./promote-screen.module.css";

type SignoffRow = OpsPromoteView["signoffs"][number];
type FeedbackRow = OpsPromoteView["feedback"][number];

function promoTone(val: string | null): BadgeTone {
  if (val === "Ready") return "ok";
  if (val === "Blocked") return "danger";
  if (val === "Watching") return "warn";
  return "info";
}

export function PromoteScreen() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "read.running");

  const query = useQuery({
    queryKey: opsQueryKeys.promote,
    queryFn: fetchOpsPromote,
    enabled: allowed,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (query.data?.evaluated_at) reportEvaluatedAt(query.data.evaluated_at);
  }, [query.data?.evaluated_at, reportEvaluatedAt]);

  if (!allowed) {
    return (
      <O0State
        model={classifyOpsError(
          new OpsApiError(403, {
            code: "OPS_ACTION_DENIED",
            message: "Promote view requires read.running permission.",
            support_ref: "cedar-running",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return <div className={s.page}><PageHead title={COPY.running.title} meta={COPY.loading.promoteTitle} tabs={buildRunningTabs("promote")} /></div>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const rawDigest = readObservedValue(data.candidate_digest);
  const digest = typeof rawDigest === "string" ? rawDigest : "";
  const rawState = readObservedValue(data.state);
  const promoState = typeof rawState === "string" ? rawState : null;

  const signCols: readonly TableColumn<SignoffRow>[] = [
    { id: "verdict", header: COPY.promote.verdictLabel, mobileSlot: "badge", nowrap: true, render: (r) => <Badge tone={r.verdict === "ready" ? "ok" : "danger"}>{formatPromoteVerdict(r.verdict)}</Badge> },
    { id: "operator", header: COPY.actions.cols.operator, mobileSlot: "title", render: (r) => r.operator },
    { id: "note", header: COPY.promote.noteLabel, mobileSlot: "meta", render: (r) => r.note },
    { id: "at", header: COPY.actions.cols.at, nowrap: true, render: (r) => formatUtcShort(r.at) },
  ];

  const fbCols: readonly TableColumn<FeedbackRow>[] = [
    { id: "sev", header: COPY.promote.severityLabel, mobileSlot: "badge", nowrap: true, render: (r) => <Badge tone={r.severity === "P0" ? "danger" : r.severity === "P1" ? "warn" : "info"}>{r.severity}</Badge> },
    { id: "id", header: COPY.promote.feedbackIdLabel, mobileSlot: "title", render: (r) => `${r.feedback_id} · ${r.note}` },
    { id: "disp", header: COPY.promote.dispositionLabel, mobileSlot: "meta", nowrap: true, render: (r) => <Badge tone={r.disposition === "open" ? "warn" : "ok"}>{formatFeedbackDisposition(r.disposition)}</Badge> },
    { id: "at", header: COPY.actions.cols.at, nowrap: true, render: (r) => formatUtcShort(r.at) },
  ];

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.running.title}
        meta={<span className={s.metaText}>{fmtColon(COPY.status.evaluatedAt, formatUtcTimestamp(data.evaluated_at))}</span>}
        tabs={buildRunningTabs("promote")}
      />

      <StatRow
        items={[
          { id: "candidate", label: COPY.promote.candidateLabel, value: <ObservedValue observation={data.candidate_digest} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} /> },
          {
            id: "state",
            label: COPY.promote.stateLabel,
            value: promoState ? <Badge tone={promoTone(promoState)}>{promoState}</Badge> : <ObservedValue observation={data.state} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} />,
          },
        ]}
      />

      <PromoteForms digest={digest} promoState={promoState} />

      <div className={s.splitGrid}>
        <section className={s.splitCell} aria-labelledby="promote-signoffs">
          <div className={s.bandHead}><h2 id="promote-signoffs" className={s.bandTitle}>{COPY.promote.signoffsTitle}</h2></div>
          {data.signoffs.length > 0 ? (
            <CompactTable caption={COPY.promote.signoffsTitle} rows={data.signoffs} rowKey={(r) => `${r.seq}`} columns={signCols} />
          ) : (
            <p className={s.emptyNote}>{COPY.promote.noSignoffs}</p>
          )}
        </section>
        <section className={s.splitCell} aria-labelledby="promote-feedback">
          <div className={s.bandHead}><h2 id="promote-feedback" className={s.bandTitle}>{COPY.promote.feedbackTitle}</h2></div>
          {data.feedback.length > 0 ? (
            <CompactTable caption={COPY.promote.feedbackTitle} rows={data.feedback} rowKey={(r) => `${r.seq}-${r.feedback_id}`} columns={fbCols} />
          ) : (
            <p className={s.emptyNote}>{COPY.promote.noFeedback}</p>
          )}
        </section>
      </div>
    </div>
  );
}
