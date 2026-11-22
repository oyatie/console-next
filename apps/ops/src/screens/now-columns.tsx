// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { COPY } from "../copy";
import type { OpsHomeSnapshot, OpsLive } from "../lib/api";
import { formatDuration, formatUtcShort } from "../lib/format";
import { Badge, type BadgeTone } from "../ui/badge";
import type { TableColumn } from "../ui/compact-table";
import { ObservedValue } from "../ui/observed-value";

export type WorkRow = OpsHomeSnapshot["worklist"][number];
export type ChangingRow = OpsHomeSnapshot["changing"][number];

function workKindTone(kind: WorkRow["kind"]): BadgeTone {
  if (kind === "page" || kind === "overdue") return "danger";
  if (kind === "due") return "warn";
  return "outline";
}

export function buildWorkColumns(liveStatus: OpsLive, disconnectedAgeS: number): readonly TableColumn<WorkRow>[] {
  return [
    {
      id: "kind",
      header: COPY.now.cols.kind,
      mobileSlot: "badge",
      nowrap: true,
      cellTone: (r) => (r.kind === "page" || r.kind === "overdue" ? "danger" : r.kind === "due" ? "warn" : undefined),
      render: (r) => <Badge tone={workKindTone(r.kind)}>{r.kind}</Badge>,
    },
    {
      id: "title",
      header: COPY.now.cols.title,
      mobileSlot: "title",
      render: (r) => <ObservedValue observation={r.title} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />,
    },
    {
      id: "component",
      header: COPY.now.cols.component,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) => <ObservedValue observation={r.component} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />,
    },
    {
      id: "state",
      header: COPY.now.cols.state,
      nowrap: true,
      render: (r) => <ObservedValue observation={r.state} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} asBadge />,
    },
    {
      id: "since",
      header: COPY.now.cols.since,
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.since}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatUtcShort(String(v))}
        />
      ),
    },
    {
      id: "age",
      header: COPY.now.cols.age,
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.age}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatDuration(Number(v))}
        />
      ),
    },
    {
      id: "lead",
      header: COPY.now.cols.lead,
      nowrap: true,
      render: (r) =>
        r.lead ? (
          <ObservedValue observation={r.lead} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />
        ) : (
          <span>{COPY.now.unassigned}</span>
        ),
    },
    {
      id: "next",
      header: COPY.now.cols.next,
      mobileSlot: "action",
      nowrap: true,
      align: "right",
      render: (r) => (
        <Link to={r.next.href} className="btn btn--sm">
          {r.next.label}
        </Link>
      ),
    },
  ];
}

export function buildChangingColumns(liveStatus: OpsLive, disconnectedAgeS: number): readonly TableColumn<ChangingRow>[] {
  return [
    { id: "key", header: COPY.now.cols.key, mobileSlot: "title", render: (r) => r.key },
    {
      id: "colour",
      header: COPY.now.cols.colour,
      mobileSlot: "badge",
      nowrap: true,
      render: (r) => <ObservedValue observation={r.colour} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} asBadge />,
    },
    {
      id: "step",
      header: COPY.now.cols.canaryStep,
      mobileSlot: "meta",
      nowrap: true,
      render: (r) => <ObservedValue observation={r.canary_step} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} />,
    },
    {
      id: "weight",
      header: COPY.now.cols.weight,
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.weight_percent}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => `${Number(v)}%`}
        />
      ),
    },
    {
      id: "watch",
      header: COPY.now.cols.watchUntil,
      nowrap: true,
      render: (r) => (
        <ObservedValue
          observation={r.watch_until}
          liveStatus={liveStatus}
          disconnectedAgeS={disconnectedAgeS}
          formatValue={(v) => formatUtcShort(String(v))}
        />
      ),
    },
    {
      id: "freeze",
      header: COPY.now.cols.freeze,
      nowrap: true,
      render: (r) => <ObservedValue observation={r.freeze} liveStatus={liveStatus} disconnectedAgeS={disconnectedAgeS} asBadge />,
    },
    {
      id: "next",
      header: COPY.now.cols.next,
      mobileSlot: "action",
      nowrap: true,
      align: "right",
      render: (r) => (
        <Link to={r.next.href} className="btn btn--sm">
          {r.next.label}
        </Link>
      ),
    },
  ];
}
