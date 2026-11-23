// SPDX-License-Identifier: LicenseRef-Proprietary
import { phoneDisplay } from "../../../lib/pure/formats";
import type { components } from "@console/api/schema";

type MeProfile = components["schemas"]["MeProfileResponse"];
type SelfIssueCertificateRequest = components["schemas"]["SelfIssueCertificateRequest"];
type SelfRevealField = components["schemas"]["SelfRevealRequest"]["field"];

interface PayslipSummaryLike {
  title: string;
  payslip_meta?: {
    attribution_month?: string | null;
    period_end?: string | null;
  } | null;
}

/** Extract the attribution month (YYYY-MM) from an inbox payslip summary when available. */
export function payslipMonthSource(doc: PayslipSummaryLike): string | null {
  const meta = doc.payslip_meta;
  return meta?.attribution_month ?? meta?.period_end?.slice(0, 7) ?? /\d{4}-\d{2}/.exec(doc.title)?.[0] ?? null;
}

/** Combine grade and position without duplicating when `position` already carries `grade`. */
export function formatEmploymentGradeRole(grade?: string | null, position?: string | null): string | null {
  const g = grade?.trim() || "";
  const p = position?.trim() || "";
  if (!g && !p) return null;
  if (g && p) return p === g || p.includes(g) ? p : `${g} · ${p}`;
  return g || p;
}

type EmploymentStatusBadge = {
  code: "ACTIVE" | "ON_LEAVE" | "PRE_HIRE" | "EXITED";
  tone: "ok" | "warn" | "info" | "neutral";
};

/** Map backend employment status string to canonical code and chip tone. */
export function employmentStatusBadge(status?: string | null): EmploymentStatusBadge | null {
  switch (status) {
    case "ACTIVE":
      return { code: "ACTIVE", tone: "ok" };
    case "ON_LEAVE":
      return { code: "ON_LEAVE", tone: "warn" };
    case "PRE_HIRE":
    case "UPCOMING":
      return { code: "PRE_HIRE", tone: "info" };
    case "EXITED":
      return { code: "EXITED", tone: "neutral" };
    default:
      return null;
  }
}

/** Find an open self-service profile change request for a given field. */
export function openRequestForField(
  openRequests: ReadonlyArray<MeProfile["open_change_requests"][number]> | undefined,
  field: string,
) {
  return (openRequests ?? []).find((req) => req.field === field && req.status === "OPEN");
}

/** Format a revealed `KrAddress` payload for display in local ephemeral state. */
function formatRevealedAddress(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
  const a = value as {
    road_addr_part1?: string | null;
    detail?: string | null;
    road_addr_part2?: string | null;
    as_printed?: string | null;
  };
  const joined = [a.road_addr_part1, a.detail, a.road_addr_part2].filter(Boolean).join(" ").trim();
  return joined || a.as_printed?.trim() || "";
}

type RevealedEmergencyContact = {
  name: string;
  relation: string;
  phone: string;
};

/** Parse revealed emergency contacts array from `/api/v1/me/profile/reveal`. */
export function parseRevealedEmergencyContacts(value: unknown): RevealedEmergencyContact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { name?: unknown; relation?: unknown; phone?: unknown } => Boolean(item && typeof item === "object"))
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      relation: typeof item.relation === "string" ? item.relation : "OTHER",
      phone: typeof item.phone === "string" ? item.phone : "",
    }))
    .filter((item) => Boolean(item.name || item.phone));
}

/** Format revealed field payload for concise ephemeral inline display. */
export function formatRevealedValue(
  field: SelfRevealField,
  value: unknown,
  relationLabel: (relation: string) => string,
): string {
  if (field === "PHONE") {
    const raw = typeof value === "string" ? value : "";
    return phoneDisplay(raw) || raw;
  }
  if (field === "ADDRESS") {
    return formatRevealedAddress(value);
  }
  const contacts = parseRevealedEmergencyContacts(value);
  return contacts
    .map((c) => `${c.name} (${relationLabel(c.relation)}) · ${phoneDisplay(c.phone) || c.phone}`)
    .join(" / ");
}

/** Mirror server eligibility rules (`EMPLOYMENT` blocked when exited; `EXIT` requires exited). */
export function certificateKindEligible(
  kind: SelfIssueCertificateRequest["kind"],
  employmentStatus?: string | null,
): boolean {
  if (!employmentStatus) return true;
  if (kind === "EXIT") return employmentStatus === "EXITED";
  if (kind === "EMPLOYMENT") return employmentStatus !== "EXITED";
  return true;
}
