// SPDX-License-Identifier: LicenseRef-Proprietary
import type { QueryClient } from "@tanstack/react-query";
import { openEventStream, type EventStream, type StreamSnapshot } from "@console/api/events";
import type {
  OpsAlertDetail,
  OpsAlertGroup,
  OpsAlertGroupDetail,
  OpsAlertGroups,
  OpsComponent,
  OpsEvent,
  OpsHomeSnapshot,
  OpsJob,
  OpsLive,
  OpsRunning,
  OpsSource,
  OpsSources,
  OpsJobs,
} from "./api";

export type LiveStatusSnapshot = {
  status: OpsLive;
  paused: boolean;
  pendingCount: number;
  lastEventAt: number | null;
  disconnectedSince: number | null;
  disconnectedAgeS: number;
};

const TUNE = {
  retryHint: 1_500,
  reconnectBackoffMax: 15_000,
  backoffResetAfter: 30_000,
  heartbeatInterval: 15_000,
  deadAfterHeartbeats: 3,
};

function groupFromDetail(detail: OpsAlertGroupDetail): OpsAlertGroup {
  return {
    key: detail.key,
    alertname: detail.alertname,
    component: detail.component,
    severity: detail.severity,
    state: detail.state,
    since: detail.since,
    members_n: detail.members_n,
    summary: detail.summary,
    value_vs_threshold: detail.value_vs_threshold,
    lead: detail.lead,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applyOpsEventToCache(queryClient: QueryClient, event: OpsEvent | unknown): void {
  if (!isRecord(event) || typeof event.type !== "string") return;

  if (event.type === "home.changed") {
    if (!isRecord(event.home) || !isRecord(event.home.verdict)) return;
    queryClient.setQueryData<OpsHomeSnapshot>(["ops", "home"], event.home as OpsHomeSnapshot);
    return;
  }
  if (event.type === "alert.group.changed" || event.type === "alert.group.resolved") {
    if (!isRecord(event.group) || typeof event.group.key !== "string" || typeof event.evaluated_at !== "string") return;
    const detail = event.group as OpsAlertGroupDetail;
    const evaluatedAt = event.evaluated_at;
    queryClient.setQueryData<OpsAlertDetail>(["ops", "alert", detail.key], (prev) => ({
      evaluated_at: evaluatedAt,
      group: prev ? { ...prev.group, ...detail } : detail,
    }));
    const summaryGroup = groupFromDetail(detail);
    queryClient.setQueriesData<OpsAlertGroups>({ queryKey: ["ops", "alerts"] }, (prev) => {
      if (!prev) return prev;
      const idx = prev.groups.findIndex((g) => g.key === summaryGroup.key);
      const nextGroups = idx >= 0
        ? prev.groups.map((g, i) => (i === idx ? summaryGroup : g))
        : [summaryGroup, ...prev.groups];
      return { ...prev, evaluated_at: evaluatedAt, groups: nextGroups };
    });
    return;
  }
  if (event.type === "component.changed") {
    if (!isRecord(event.component) || typeof event.component.key !== "string" || typeof event.evaluated_at !== "string") return;
    const comp = event.component as OpsComponent;
    const evaluatedAt = event.evaluated_at;
    queryClient.setQueriesData<OpsRunning>({ queryKey: ["ops", "running"] }, (prev) => {
      if (!prev || !("components" in prev)) return prev;
      const idx = prev.components.findIndex((c) => c.key === comp.key);
      const next = idx >= 0 ? prev.components.map((c, i) => (i === idx ? comp : c)) : [comp, ...prev.components];
      return { ...prev, evaluated_at: evaluatedAt, components: next };
    });
    return;
  }
  if (event.type === "job.changed") {
    if (!isRecord(event.job) || typeof event.job.name !== "string" || typeof event.evaluated_at !== "string") return;
    const job = event.job as OpsJob;
    const evaluatedAt = event.evaluated_at;
    queryClient.setQueryData<OpsJobs>(["ops", "running", "jobs"], (prev) => {
      if (!prev) return prev;
      const idx = prev.jobs.findIndex((j) => j.name === job.name);
      const next = idx >= 0 ? prev.jobs.map((j, i) => (i === idx ? job : j)) : [job, ...prev.jobs];
      return { ...prev, evaluated_at: evaluatedAt, jobs: next };
    });
    return;
  }
  if (event.type === "source.changed") {
    if (!isRecord(event.source) || typeof event.source.name !== "string" || typeof event.evaluated_at !== "string") return;
    const src = event.source as OpsSource;
    const evaluatedAt = event.evaluated_at;
    queryClient.setQueryData<OpsSources>(["ops", "sources"], (prev) => {
      if (!prev) return prev;
      const idx = prev.sources.findIndex((s) => s.name === src.name);
      const next = idx >= 0 ? prev.sources.map((s, i) => (i === idx ? src : s)) : [src, ...prev.sources];
      return { ...prev, evaluated_at: evaluatedAt, sources: next };
    });
    return;
  }
  if (event.type === "resync") {
    void queryClient.invalidateQueries({ queryKey: ["ops"], refetchType: "active" });
  }
}

export class OpsLiveController {
  private readonly queryClient: QueryClient;
  private readonly openStream: typeof openEventStream;
  private stream: EventStream | null = null;
  private streamSnap: StreamSnapshot = { state: "connecting", since: Date.now(), lastEventAt: null, partial: [] };
  private paused = false;
  private heldEvents: OpsEvent[] = [];
  private heldResync = false;
  private disconnectedSince: number | null = null;
  private lastEventAt: number | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: LiveStatusSnapshot = {
    status: "Reconnecting",
    paused: false,
    pendingCount: 0,
    lastEventAt: null,
    disconnectedSince: null,
    disconnectedAgeS: 0,
  };

  constructor(queryClient: QueryClient, openStream: typeof openEventStream = openEventStream) {
    this.queryClient = queryClient;
    this.openStream = openStream;
  }

  start(): () => void {
    if (this.stream) return () => {};
    this.disconnectedSince = this.disconnectedSince ?? Date.now();
    this.stream = this.openStream({
      url: "/api/ops/v1/events",
      token: () => null,
      refresh: async () => false,
      tune: TUNE,
      onFrame: ({ event, data }) => {
        if (!isRecord(data)) return;
        const payload = { ...data, type: event } as unknown as OpsEvent;
        this.lastEventAt = Date.now();
        this.disconnectedSince = null;
        if (event === "heartbeat") {
          this.recompute();
          return;
        }
        if (this.paused) {
          if (event === "resync") this.heldResync = true;
          else this.heldEvents.push(payload);
          this.recompute();
          return;
        }
        applyOpsEventToCache(this.queryClient, payload);
        this.recompute();
      },
    });
    this.streamSnap = this.stream.get();
    if (this.streamSnap.state === "live") {
      this.disconnectedSince = null;
    }
    const unsub = this.stream.subscribe(() => {
      if (!this.stream) return;
      this.streamSnap = this.stream.get();
      if (this.streamSnap.state === "live") {
        this.disconnectedSince = null;
      } else if (this.disconnectedSince === null) {
        this.disconnectedSince = Date.now();
      }
      this.recompute();
    });
    this.recompute();
    return () => {
      unsub();
      this.stream?.close();
      this.stream = null;
    };
  }

  private recompute(): void {
    let status: OpsLive = "Reconnecting";
    if (this.streamSnap.state === "offline") status = "Offline";
    else if (this.streamSnap.state === "connecting") status = "Reconnecting";
    else if (this.paused) status = "Paused";
    else status = "Live";
    const disconnectedSince =
      status === "Reconnecting" || status === "Offline" ? (this.disconnectedSince ?? Date.now()) : null;
    const disconnectedAgeS =
      disconnectedSince !== null ? Math.max(1, Math.round((Date.now() - disconnectedSince) / 1000)) : 0;
    this.snapshot = {
      status,
      paused: this.paused,
      pendingCount: this.heldEvents.length + (this.heldResync ? 1 : 0),
      lastEventAt: this.lastEventAt ?? this.streamSnap.lastEventAt,
      disconnectedSince,
      disconnectedAgeS,
    };
    this.listeners.forEach((l) => l());
  }

  togglePause(): void {
    if (this.paused) this.showHeld();
    else {
      this.paused = true;
      this.recompute();
    }
  }

  showHeld(): void {
    const events = this.heldEvents.splice(0, this.heldEvents.length);
    const resync = this.heldResync;
    this.heldResync = false;
    this.paused = false;
    if (resync) {
      void this.queryClient.invalidateQueries({ queryKey: ["ops"], refetchType: "active" });
    } else {
      for (const ev of events) applyOpsEventToCache(this.queryClient, ev);
    }
    this.recompute();
  }

  reconnect(): void {
    this.stream?.reconnect();
  }

  getSnapshot = (): LiveStatusSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
