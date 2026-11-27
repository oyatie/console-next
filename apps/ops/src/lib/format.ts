// SPDX-License-Identifier: LicenseRef-Proprietary
import { OPS_FORMAT_LABELS_KO } from "@console/i18n/ops-ko";
import { COPY } from "../copy";
import { getOpsLocale } from "./locale";

const numFmt = new Intl.NumberFormat("en-US");
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const KST_OFFSET_MS = 9 * 3_600_000;

function kstParts(d: Date): { y: string; m: string; day: string; h: string; min: string; s: string } {
  const shifted = new Date(d.getTime() + KST_OFFSET_MS).toISOString();
  return {
    y: shifted.slice(0, 4),
    m: shifted.slice(5, 7),
    day: shifted.slice(8, 10),
    h: shifted.slice(11, 13),
    min: shifted.slice(14, 16),
    s: shifted.slice(17, 19),
  };
}

export function formatUtcTimestamp(iso: string | null | undefined): string {
  if (!iso) return `${COPY.observed.unknownPrefix}missing timestamp`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (getOpsLocale() === "ko") {
    const p = kstParts(d);
    return `${p.y}-${p.m}-${p.day} ${p.h}:${p.min}:${p.s} KST`;
  }
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatUtcShort(iso: string | null | undefined): string {
  if (!iso) return `${COPY.observed.unknownPrefix}missing timestamp`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (getOpsLocale() === "ko") {
    const p = kstParts(d);
    return `${p.m}-${p.day} ${p.h}:${p.min} KST`;
  }
  const full = d.toISOString();
  return `${full.slice(5, 10)} ${full.slice(11, 16)}Z`;
}

export function formatUtcClock(ms: number): string {
  if (getOpsLocale() === "ko") {
    const p = kstParts(new Date(ms));
    return `${p.h}:${p.min}:${p.s} KST`;
  }
  return new Date(ms).toISOString().slice(11, 19) + "Z";
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;
  const mins = Math.floor(whole / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? numFmt.format(value) : "0";
}

export function formatUsd(value: number): string {
  return Number.isFinite(value) ? `${usdFmt.format(value)} USD` : "$0.00 USD";
}

export function formatBurn(value: number): string {
  return Number.isFinite(value) ? `${pctFmt.format(value)}x` : "0.0x";
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0.0%";
  return `${pctFmt.format(value)}%`;
}

export function formatBudgetPercent(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  if (value <= 0) return COPY.now.exhausted;
  return `${pctFmt.format(value)}%`;
}

export function formatObservedPrimitive(value: unknown, unit: string | null): string {
  if (typeof value === "boolean") return value ? COPY.now.freezeActive : COPY.now.freezeClear;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${COPY.observed.unknownPrefix}${COPY.observed.notInstrumented}`;
    if (unit === "s") return formatDuration(value);
    if (unit === "USD" || unit === "usd") return formatUsd(value);
    if (unit === "x" || unit === "burn") return formatBurn(value);
    if (unit === "%") return `${pctFmt.format(value)}%`;
    return unit ? `${numFmt.format(value)} ${unit}` : numFmt.format(value);
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return formatUtcShort(value);
    return unit ? `${value} ${unit}` : value;
  }
  return String(value ?? "");
}

export function fmtJoin(...parts: (string | number | null | undefined)[]): string {
  return parts.filter((p) => p !== null && p !== undefined && p !== "").join("");
}

export function fmtCountLabel(label: string, count: number): string {
  return `${label} (${count})`;
}

export function fmtColon(label: string, value: string): string {
  return `${label}: ${value}`;
}

const LEGAL_CLOCK_LABELS: Record<string, string> = {
  intrusion_24h: "Intrusion 24h",
  pipc_kisa_72h: "PIPC / KISA 72h",
};

const INCIDENT_TIMELINE_LABELS: Record<string, string> = {
  declared: "Declared",
  note_added: "Note added",
  lead_assigned: "Lead assigned",
  severity_changed: "Severity changed",
  status_changed: "Status changed",
  postmortem_linked: "Postmortem linked",
  public_attached: "Public incident attached",
  mitigation_added: "Mitigation added",
  notice_sent: "Notice sent",
  resolved: "Resolved",
};

const OBLIGATION_EVENT_LABELS: Record<string, string> = {
  opened: "Opened",
  in_review: "In review",
  redated: "Redated",
  done: "Done",
  waived: "Waived",
};

const OBLIGATION_KIND_LABELS: Record<string, string> = {
  "launch-gate": "Launch gate",
  "professional-review": "Professional review",
  "credential-rotation": "Credential rotation",
  escrow: "Escrow",
  drill: "Drill",
  "owner-decision": "Owner decision",
  "regulatory-watch": "Regulatory watch",
};

const OBLIGATION_STATE_LABELS: Record<string, string> = {
  open: "Open",
  "in-review": "In review",
  done: "Done",
  waived: "Waived",
};

const OBLIGATION_ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  "labor-attorney": "Labor attorney",
  lawyer: "Lawyer",
  "tax-accountant": "Tax accountant",
};

const PDATA_IMPACT_LABELS: Record<string, string> = {
  no: "No",
  unknown: "Unknown",
  yes: "Yes",
};

const PROMOTE_VERDICT_LABELS: Record<string, string> = {
  ready: "Ready",
  blocked: "Blocked",
};

const FEEDBACK_DISPOSITION_LABELS: Record<string, string> = {
  open: "Open",
  triaged: "Triaged",
  resolved: "Resolved",
  wontfix: "Won't fix",
};

function humanizeToken(raw: string): string {
  const clean = raw.replace(/[_-]+/g, " ").trim();
  return clean ? `${clean.charAt(0).toUpperCase()}${clean.slice(1)}` : raw;
}

export function formatLegalClockKind(kind: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.legalClock : LEGAL_CLOCK_LABELS;
  return map[kind] ?? humanizeToken(kind);
}

export function formatIncidentTimelineKind(kind: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.incidentTimeline : INCIDENT_TIMELINE_LABELS;
  return map[kind] ?? humanizeToken(kind);
}

export function formatObligationEvent(event: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.obligationEvent : OBLIGATION_EVENT_LABELS;
  return map[event] ?? humanizeToken(event);
}

export function formatObligationKind(kind: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.obligationKind : OBLIGATION_KIND_LABELS;
  return map[kind] ?? humanizeToken(kind);
}

export function formatObligationState(state: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.obligationState : OBLIGATION_STATE_LABELS;
  return map[state] ?? humanizeToken(state);
}

export function formatObligationRole(role: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.obligationRole : OBLIGATION_ROLE_LABELS;
  return map[role] ?? humanizeToken(role);
}

export function formatPersonalDataImpact(impact: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.pdataImpact : PDATA_IMPACT_LABELS;
  return map[impact] ?? humanizeToken(impact);
}

export function formatPromoteVerdict(verdict: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.promoteVerdict : PROMOTE_VERDICT_LABELS;
  return map[verdict] ?? humanizeToken(verdict);
}

export function formatFeedbackDisposition(disposition: string): string {
  const map = getOpsLocale() === "ko" ? OPS_FORMAT_LABELS_KO.feedbackDisposition : FEEDBACK_DISPOSITION_LABELS;
  return map[disposition] ?? humanizeToken(disposition);
}
