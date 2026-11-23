// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, X } from "lucide-react";
import { COPY } from "../copy";
import { fetchOpsIncidentDetail, opsQueryKeys } from "../lib/api";
import { readStatusIncident } from "../lib/api-types";
import { classifyOpsError } from "../lib/auth";
import {
  fmtCountLabel,
  fmtJoin,
  formatDuration,
  formatIncidentTimelineKind,
  formatLegalClockKind,
  formatPersonalDataImpact,
  formatUtcShort,
  formatUtcTimestamp,
} from "../lib/format";
import { Badge, type BadgeTone } from "../ui/badge";
import { KeyValue } from "../ui/key-value";
import { O0State } from "../ui/o0-state";
import { IncidentForms } from "./incident-forms";
import s from "./incidents-screen.module.css";

function sevTone(sev: string): BadgeTone {
  if (sev === "SEV1") return "danger";
  if (sev === "SEV2") return "warn";
  return "info";
}

export function IncidentDetailPane({
  id,
  isMobileFull,
}: {
  id: string;
  isMobileFull?: boolean;
}) {
  const query = useQuery({
    queryKey: opsQueryKeys.incidentDetail(id),
    queryFn: () => fetchOpsIncidentDetail(id),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (query.isPending) {
    return <p className={s.emptyNote}>{COPY.loading.incidentDetailTitle}</p>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const inc = query.data.incident;
  const pubCard = readStatusIncident(inc.public_card);

  return (
    <div className={s.detailStack}>
      {isMobileFull ? (
        <div className={s.mobileBack}>
          <Link to="/incidents" className="btn btn--sm">
            <ArrowLeft size={12} aria-hidden="true" />
            <span>{COPY.incidents.back}</span>
          </Link>
        </div>
      ) : null}

      <section className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.incidents.sections.details}</h3>
        <div className={s.badgeRow}>
          <Badge tone={sevTone(inc.sev)}>{inc.sev}</Badge>
          <Badge tone={inc.status === "Resolved" ? "ok" : "warn"}>{inc.status}</Badge>
          <Badge tone="outline">{fmtJoin("seq ", inc.head_seq)}</Badge>
        </div>
        <KeyValue
          items={[
            { id: "title", label: COPY.incidents.cols.title, value: inc.title },
            { id: "lead", label: COPY.incidents.cols.lead, value: inc.lead ?? COPY.now.unassigned },
            { id: "components", label: COPY.incidents.cols.components, value: inc.affected_components.join(", ") || COPY.observed.notInstrumented },
            { id: "pdata", label: COPY.incidents.fields.personalDataImpact, value: formatPersonalDataImpact(inc.personal_data_impact) },
            { id: "discovered", label: COPY.incidents.cols.discoveredAt, value: formatUtcTimestamp(inc.discovered_at) },
            { id: "postmortem", label: COPY.incidents.fields.postmortemRef, value: inc.postmortem_ref ?? COPY.observed.notInstrumented },
            { id: "publicId", label: COPY.incidents.cols.publicIncidentId, value: inc.public_incident_id ?? COPY.observed.notInstrumented },
          ]}
        />
      </section>

      <section className={s.detailSection}>
        <h3 className={s.detailLabel}>{COPY.incidents.sections.clocks}</h3>
        {inc.legal_clocks.length > 0 ? (
          <ul className={s.list}>
            {inc.legal_clocks.map((clk) => (
              <li key={clk.kind} className={s.clockRow}>
                <strong>{formatLegalClockKind(clk.kind)}</strong>
                <Badge tone={clk.overdue ? "danger" : "warn"}>
                  {clk.overdue ? COPY.incidents.sections.overdue : formatDuration(clk.remaining_s)}
                </Badge>
                <span className={s.metaText}>{formatUtcShort(clk.deadline)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.emptyInline}>{COPY.incidents.sections.noClocks}</p>
        )}
      </section>

      {pubCard ? (
        <section className={s.detailSection}>
          <h3 className={s.detailLabel}>{COPY.incidents.sections.publicCard}</h3>
          <div className={s.pubCard}>
            <strong>{fmtJoin(pubCard.id, " · ", pubCard.title.en ?? pubCard.title.ko)}</strong>
            {pubCard.updates.map((u, idx) => (
              <div key={`${u.n}-${idx}`} className={s.pubUpdate}>
                <Badge tone="info">{fmtJoin("#", u.n, " ", formatIncidentTimelineKind(u.stage))}</Badge>
                <span>{u.text.en ?? u.text.ko}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <IncidentForms incident={inc} onReload={() => void query.refetch()} />

      <section className={s.detailSection}>
        <h3 className={s.detailLabel}>{fmtCountLabel(COPY.incidents.sections.timeline, inc.timeline.length)}</h3>
        <ul className={s.list}>
          {inc.timeline.map((entry) => (
            <li key={entry.seq} className={s.timelineRow}>
              <div className={s.clockRow}>
                <Badge tone="outline">{fmtJoin("#", entry.seq, " ", formatIncidentTimelineKind(entry.kind))}</Badge>
                <span className={s.metaText}>{fmtJoin(entry.actor, " · ", formatUtcShort(entry.at))}</span>
              </div>
              <span>{entry.summary}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function IncidentCloseButton() {
  return (
    <Link to="/incidents" className={`btn btn--sm ${s.desktopClose}`} aria-label={COPY.alerts.closeDetail}>
      <X size={12} aria-hidden="true" />
      <span>{COPY.alerts.closeDetail}</span>
    </Link>
  );
}
