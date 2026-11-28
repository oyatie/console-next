// SPDX-License-Identifier: LicenseRef-Proprietary
import { RECONNECTING_AFTER_MS } from "../../../lib/freshness";
import { liveStatus, retryLive } from "../../../lib/live/live";
import { DEFAULT_STATUS_ORIGIN, resolveStatusOrigin, STATUS_PAGE_URL } from "../../../lib/live/status-origin";

export { DEFAULT_STATUS_ORIGIN, resolveStatusOrigin, STATUS_PAGE_URL };

const STATUS_TIMEOUT_MS = 5_000;

type ComponentStatus = "ok" | "unknown" | "maint" | "degraded" | "partial" | "major";
type OutageSeverity = "major" | "partial" | "degraded";
type LocalizedLabel = { ko: string; en: string | null };

type OutageInfo = {
  severity: OutageSeverity;
  title: LocalizedLabel | null;
  affected: LocalizedLabel[];
  expiresAtMs: number;
};

type ActiveStatus =
  | ({ kind: "outage" } & OutageInfo)
  | { kind: "ok"; expiresAtMs: number }
  | { kind: "unknown" };

const SEVERITY_RANK: Record<ComponentStatus, number> = {
  unknown: 0,
  ok: 1,
  maint: 2,
  degraded: 3,
  partial: 4,
  major: 5,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isComponentStatus(value: unknown): value is ComponentStatus {
  return (
    value === "ok" ||
    value === "unknown" ||
    value === "maint" ||
    value === "degraded" ||
    value === "partial" ||
    value === "major"
  );
}

function isOutageSeverity(value: ComponentStatus): value is OutageSeverity {
  return value === "major" || value === "partial" || value === "degraded";
}

function readLocalized(value: unknown, fallback: string): LocalizedLabel {
  if (isRecord(value) && typeof value.ko === "string" && value.ko.trim()) {
    return {
      ko: value.ko.trim(),
      en: typeof value.en === "string" && value.en.trim() ? value.en.trim() : null,
    };
  }
  return { ko: fallback, en: null };
}

export function pickLocalized(label: LocalizedLabel, locale: "ko" | "en"): string {
  return locale === "en" && label.en ? label.en : label.ko;
}

export function parseActiveStatus(raw: unknown, now = Date.now()): ActiveStatus {
  if (!isRecord(raw) || raw.schema !== 1) return { kind: "unknown" };
  if (typeof raw.evidence_expires_at !== "string" || !raw.evidence_expires_at.trim()) {
    return { kind: "unknown" };
  }
  const expiresAtMs = Date.parse(raw.evidence_expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    return { kind: "unknown" };
  }
  if (!isRecord(raw.components)) return { kind: "unknown" };
  if (raw.incidents !== undefined && !Array.isArray(raw.incidents)) return { kind: "unknown" };

  let worst: ComponentStatus = "unknown";
  let hasKnownState = false;
  const names = new Map<string, LocalizedLabel>();
  const affectedKeys = new Set<string>();

  for (const [key, entry] of Object.entries(raw.components)) {
    if (!isRecord(entry) || !isComponentStatus(entry.status)) return { kind: "unknown" };
    names.set(key, readLocalized(entry.name, key));
    if (entry.status !== "unknown") hasKnownState = true;
    if (SEVERITY_RANK[entry.status] > SEVERITY_RANK[worst]) worst = entry.status;
    if (isOutageSeverity(entry.status)) affectedKeys.add(key);
  }

  let bestIncidentRank = 0;
  let bestTitle: LocalizedLabel | null = null;
  for (const incident of raw.incidents ?? []) {
    if (!isRecord(incident)) return { kind: "unknown" };
    if (incident.stage === "resolved") continue;
    let incRank = 0;
    if (isRecord(incident.components)) {
      for (const [key, st] of Object.entries(incident.components)) {
        if (!isComponentStatus(st)) continue;
        if (st !== "unknown") hasKnownState = true;
        if (SEVERITY_RANK[st] > SEVERITY_RANK[worst]) worst = st;
        if (SEVERITY_RANK[st] > incRank) incRank = SEVERITY_RANK[st];
        if (isOutageSeverity(st)) affectedKeys.add(key);
      }
    }
    if (
      incRank > bestIncidentRank &&
      isRecord(incident.title) &&
      typeof incident.title.ko === "string" &&
      incident.title.ko.trim()
    ) {
      bestIncidentRank = incRank;
      bestTitle = readLocalized(incident.title, "");
    }
  }

  if (isOutageSeverity(worst)) {
    const affected = [...affectedKeys].map(key => names.get(key) ?? { ko: key, en: null });
    return { kind: "outage", severity: worst, title: bestTitle, affected, expiresAtMs };
  }
  return hasKnownState ? { kind: "ok", expiresAtMs } : { kind: "unknown" };
}

export async function fetchActiveStatus(signal?: AbortSignal, now?: number): Promise<ActiveStatus> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${STATUS_PAGE_URL}/active.json`, {
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      signal: ctrl.signal,
    });
    if (!res.ok) return { kind: "unknown" };
    const json: unknown = await res.json();
    return parseActiveStatus(json, now);
  } catch {
    return { kind: "unknown" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

type HealthNoticesSnapshot = {
  outage: OutageInfo | null;
  retrying: boolean;
  stale: boolean;
  lastEventAt: number | null;
};

const EMPTY_NOTICES: HealthNoticesSnapshot = { outage: null, retrying: false, stale: false, lastEventAt: null };
const listeners = new Set<() => void>();
let current: HealthNoticesSnapshot = EMPTY_NOTICES;
let enabled = false;
let mountEpoch = 0;
let lateSince: number | null = null;
let staleTimer: ReturnType<typeof setTimeout> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let fetchCtrl: AbortController | null = null;
let unsubLive: (() => void) | null = null;

function emit(next: HealthNoticesSnapshot) {
  current = next;
  listeners.forEach(l => l());
}

function clearTimers() {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null;
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
}

function scheduleExpiry(outage: OutageInfo | null) {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (!enabled || !outage) return;
  const remaining = outage.expiresAtMs - Date.now();
  const delay = remaining <= 0 ? 0 : Math.min(remaining, 2_147_483_647);
  expiryTimer = setTimeout(() => {
    if (!enabled) return;
    if (Date.now() >= outage.expiresAtMs) emit({ ...current, outage: null });
    else scheduleExpiry(outage);
  }, delay);
}

function refreshActive() {
  if (!enabled) return;
  const epoch = mountEpoch;
  fetchCtrl?.abort();
  const ctrl = new AbortController();
  fetchCtrl = ctrl;
  void fetchActiveStatus(ctrl.signal).then(next => {
    if (ctrl.signal.aborted || !enabled || mountEpoch !== epoch) return;
    if (fetchCtrl === ctrl) fetchCtrl = null;
    const outage = next.kind === "outage" ? { severity: next.severity, title: next.title, affected: next.affected, expiresAtMs: next.expiresAtMs } : null;
    scheduleExpiry(outage);
    emit({ ...current, outage });
  });
}

function syncStream() {
  const { state, since, lastEventAt } = liveStatus.get();
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null;
  if (enabled && state === "connecting" && lateSince !== since) {
    staleTimer = setTimeout(() => {
      lateSince = since;
      syncStream();
    }, Math.max(0, since + RECONNECTING_AFTER_MS - Date.now()));
  }
  const stale = enabled && lastEventAt !== null && ((state === "connecting" && lateSince === since) || (state === "offline" && since > 0));
  const crossedToStale = stale && !current.stale;
  if (stale !== current.stale || lastEventAt !== current.lastEventAt) {
    emit({ ...current, stale, lastEventAt });
  }
  if (crossedToStale) refreshActive();
}

export const healthStatus = {
  get: (): HealthNoticesSnapshot => (enabled ? current : EMPTY_NOTICES),
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  mount(active: boolean) {
    if (!active) return () => {};
    enabled = true;
    mountEpoch += 1;
    unsubLive = liveStatus.subscribe(syncStream);
    globalThis.addEventListener?.("online", refreshActive);
    syncStream();
    refreshActive();
    return () => {
      enabled = false;
      mountEpoch += 1;
      fetchCtrl?.abort();
      fetchCtrl = null;
      clearTimers();
      unsubLive?.();
      unsubLive = null;
      globalThis.removeEventListener?.("online", refreshActive);
      lateSince = null;
      emit(EMPTY_NOTICES);
    };
  },
  async retry() {
    if (!enabled || current.retrying) return;
    const epoch = mountEpoch;
    fetchCtrl?.abort();
    const ctrl = new AbortController();
    fetchCtrl = ctrl;
    emit({ ...current, retrying: true });
    try {
      const next = await fetchActiveStatus(ctrl.signal);
      if (ctrl.signal.aborted || !enabled || mountEpoch !== epoch) return;
      const outage = next.kind === "outage" ? { severity: next.severity, title: next.title, affected: next.affected, expiresAtMs: next.expiresAtMs } : null;
      scheduleExpiry(outage);
      emit({ ...current, outage });
      await retryLive();
    } finally {
      if (fetchCtrl === ctrl) {
        fetchCtrl = null;
      }
      if (enabled && mountEpoch === epoch) {
        emit({ ...current, retrying: false });
      }
    }
  },
};
