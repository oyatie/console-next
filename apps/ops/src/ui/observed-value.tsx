// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";
import type { OpsLive, OpsObservation } from "../lib/api";
import { fmtJoin, formatDuration, formatObservedPrimitive, formatUtcShort } from "../lib/format";
import { Badge, type BadgeTone } from "./badge";
import s from "./observed-value.module.css";

function toneForWord(word: string): BadgeTone {
  if (word === "Unknown" || word === "Never reported") return "unknown";
  if (
    word === "Healthy" ||
    word === "Synced" ||
    word === "Verified" ||
    word === "Succeeded" ||
    word === "Resolved" ||
    word === "OK" ||
    word === "Operational" ||
    word === "Ready"
  ) {
    return "ok";
  }
  if (
    word === "Progressing" ||
    word === "Monitoring" ||
    word === "Running" ||
    word === "Acked" ||
    word === "Silenced" ||
    word === "Inhibited" ||
    word === "Expected" ||
    word === "Maintenance"
  ) {
    return "info";
  }
  if (
    word === "Degraded" ||
    word === "OutOfSync" ||
    word === "Stale" ||
    word === "Suspended" ||
    word === "Late" ||
    word === "Ticket" ||
    word === "Degraded performance" ||
    word === "Partial outage" ||
    word === "Watching"
  ) {
    return "warn";
  }
  if (
    word === "Missing" ||
    word === "Firing" ||
    word === "Failed" ||
    word === "Page" ||
    word === "Major outage" ||
    word === "Blocked"
  ) {
    return "danger";
  }
  return "outline";
}

export function ObservedValue({
  observation,
  liveStatus = "Live",
  disconnectedAgeS = 0,
  asBadge = false,
  formatValue,
  showMeta = false,
}: {
  observation: OpsObservation;
  liveStatus?: OpsLive;
  disconnectedAgeS?: number;
  asBadge?: boolean;
  formatValue?: (value: unknown, unit: string | null) => string;
  showMeta?: boolean;
}) {
  const clientDisconnected = liveStatus === "Reconnecting" || liveStatus === "Offline";
  const disconnectedAge = disconnectedAgeS > 0 ? formatDuration(disconnectedAgeS) : "";

  if (observation.state === "Unknown" || observation.value === null || observation.value === undefined) {
    const reason = observation.reason?.trim() || COPY.observed.notInstrumented;
    return (
      <Badge tone="unknown" title={`${COPY.observed.sourceLabel}: ${observation.source}`}>
        {fmtJoin(COPY.observed.unknownPrefix, reason)}
      </Badge>
    );
  }

  const formatted = formatValue
    ? formatValue(observation.value, observation.unit)
    : formatObservedPrimitive(observation.value, observation.unit);

  if (clientDisconnected) {
    const staleTag = liveStatus === "Offline"
      ? fmtJoin(COPY.observed.unknownPrefix, COPY.live.offlineClientReason)
      : disconnectedAge
        ? fmtJoin(COPY.observed.staleValuePrefix, disconnectedAge)
        : fmtJoin(COPY.observed.unknownPrefix, COPY.live.staleClientReason);
    return (
      <span className={s.wrap}>
        <s className={s.struck}>{formatted}</s>
        <Badge tone="unknown">{staleTag}</Badge>
      </span>
    );
  }

  if (observation.state === "Stale") {
    const reason = observation.reason?.trim() || `stale ${formatDuration(observation.age_s)}`;
    return (
      <span className={s.wrap}>
        <s className={s.struck}>{formatted}</s>
        <Badge tone="warn">{fmtJoin(COPY.observed.stalePrefix, reason)}</Badge>
      </span>
    );
  }

  const title = `${COPY.observed.sourceLabel}: ${observation.source} · ${COPY.observed.observedAtLabel}: ${formatUtcShort(observation.observed_at)}`;

  return (
    <span className={s.wrap} title={title}>
      {asBadge ? (
        <Badge tone={toneForWord(formatted)} title={title}>{formatted}</Badge>
      ) : (
        <span className={s.value}>{formatted}</span>
      )}
      {observation.state === "Monitoring" ? <Badge tone="info">{COPY.observed.monitoringTag}</Badge> : null}
      {showMeta && observation.observed_at ? (
        <span className={s.meta}>{formatUtcShort(observation.observed_at)}</span>
      ) : null}
    </span>
  );
}
