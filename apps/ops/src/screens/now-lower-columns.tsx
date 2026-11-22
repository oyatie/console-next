// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";
import { readObservedReason, readObservedValue, type OpsHomeSnapshot, type OpsLive } from "../lib/api";
import { formatBurn, formatCount, formatDuration, formatPercent, formatUtcShort } from "../lib/format";
import { Badge } from "../ui/badge";
import type { TableColumn } from "../ui/compact-table";
import { ObservedValue } from "../ui/observed-value";
import { getStaleClientTag, isLiveDisconnected } from "../ui/stale-tag";
import s from "./now-screen.module.css";

export type BudgetRow = OpsHomeSnapshot["budgets"][number];
export type DataSafetyRow = OpsHomeSnapshot["data_safety"][number];
export type SourceRow = OpsHomeSnapshot["evidence"]["sources"][number];

export function buildBudgetColumns(liveStatus: OpsLive, disconnectedAgeS: number): readonly TableColumn<BudgetRow>[] {
  return [
    { id: "key", header: COPY.now.cols.key, mobileSlot: "title", render: (r) => r.key },
    {
      id: "remaining",
      header: COPY.now.cols.remaining,
      mobileSlot: "badge",
      cellTone: (r) => (readObservedValue(r.remaining_percent) === 0 ? "danger" : undefined),
      render: (r) => (
        <ObservedValue
          observation={r.remaining_percent}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatPercent(Number(v))}
        />
      ),
    },
    {
      id: "burn1h",
      header: COPY.now.cols.burn1h,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.burn_1h}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatBurn(Number(v))}
        />
      ),
    },
    {
      id: "burn6h",
      header: COPY.now.cols.burn6h,
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.burn_6h}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatBurn(Number(v))}
        />
      ),
    },
    {
      id: "reqs",
      header: COPY.now.cols.requests30d,
      nowrap: true,
      align: "right",
      render: (r) => (
        <ObservedValue
          observation={r.requests_30d}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatCount(Number(v))}
        />
      ),
    },
  ];
}

export function buildSafetyColumns(liveStatus: OpsLive, disconnectedAgeS: number): readonly TableColumn<DataSafetyRow>[] {
  return [
    { id: "repo", header: COPY.now.cols.repository, mobileSlot: "title", render: (r) => r.repository },
    {
      id: "rpo",
      header: COPY.now.cols.rpo,
      mobileSlot: "badge",
      render: (r) => (
        <ObservedValue
          observation={r.rpo_s}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => {
            const lim = readObservedValue(r.limit_s);
            return typeof lim === "number"
              ? `${formatDuration(Number(v))} / ${formatDuration(lim)}`
              : formatDuration(Number(v));
          }}
        />
      ),
    },
    {
      id: "backup",
      header: COPY.now.cols.lastBackup,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.last_base_backup}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatUtcShort(String(v))}
        />
      ),
    },
    {
      id: "restore",
      header: COPY.now.cols.lastRestore,
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.last_proven_restore}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatUtcShort(String(v))}
        />
      ),
    },
  ];
}

export function buildEvidenceSourceColumns(liveStatus: OpsLive, disconnectedAgeS: number): readonly TableColumn<SourceRow>[] {
  const disconnected = isLiveDisconnected(liveStatus);
  const staleTag = getStaleClientTag(liveStatus, disconnectedAgeS);
  return [
    { id: "name", header: COPY.now.cols.source, mobileSlot: "title", render: (r) => r.name },
    { id: "kind", header: COPY.now.cols.kindCol, nowrap: true, render: (r) => r.kind },
    {
      id: "state",
      header: COPY.now.cols.evidenceState,
      mobileSlot: "badge",
      render: (r) =>
        disconnected && r.state !== "Unknown" ? (
          <span className={s.staleWrap}>
            <s className={s.struckText}>{r.state}</s>
            <Badge tone="unknown">{staleTag}</Badge>
          </span>
        ) : (
          <Badge tone={r.state === "Unknown" ? "unknown" : r.state === "Stale" ? "warn" : "info"}>
            {r.state}
          </Badge>
        ),
    },
    {
      id: "reason",
      header: COPY.now.cols.reason,
      mobileSlot: "meta",
      render: (r) => readObservedReason(r) ?? COPY.observed.noActiveReason,
    },
  ];
}
