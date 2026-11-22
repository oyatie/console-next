// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";

const numFmt = new Intl.NumberFormat("en-US");
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatUtcTimestamp(iso: string | null | undefined): string {
  if (!iso) return `${COPY.observed.unknownPrefix}missing timestamp`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatUtcShort(iso: string | null | undefined): string {
  if (!iso) return `${COPY.observed.unknownPrefix}missing timestamp`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const full = d.toISOString();
  return `${full.slice(5, 10)} ${full.slice(11, 16)}Z`;
}

export function formatUtcClock(ms: number): string {
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
  if (!Number.isFinite(value)) return "0.0%";
  if (value <= 0) return COPY.now.exhausted;
  return `${pctFmt.format(value)}%`;
}

export function formatObservedPrimitive(value: unknown, unit: string | null): string {
  if (typeof value === "boolean") return value ? COPY.now.freezeActive : COPY.now.freezeClear;
  if (typeof value === "number") {
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
