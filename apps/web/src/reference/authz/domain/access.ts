// SPDX-License-Identifier: LicenseRef-Proprietary
import type { AccessEffective } from "../api";

export type Requirement = { action: keyof NonNullable<AccessEffective["decisions"]> } | { domain: AccessEffective["entries"][number]["domain"]; level: AccessEffective["entries"][number]["level"]; tenant?: boolean; scopes?: readonly AccessEffective["entries"][number]["scope"]["kind"][] };
export type ServedCapability = "served_evaluation_tasks" | "documents" | "analytics_projection" | "served_integrity_findings" | "served_integrity_triage" | "lifecycle_manage" | "served_location_consent_ledger" | "restricted_audit_stream";
export type AccessRequirement = Requirement | { servedCapability: ServedCapability } | { allOf: readonly Requirement[] } | { destinations: readonly AccessRequirement[] };

type GrantRow = AccessEffective["entries"][number];

export function enforcedRows(access: AccessEffective, domain: GrantRow["domain"], level: GrantRow["level"]) {
  // Normalized responses include view; never override a Cedar-refused view row from the same grant.
  return access.entries.filter(e =>
    e.domain === domain && e.enforcement === "ENFORCED" &&
    (e.level === level || level === "view" && ["edit", "approve", "export"].includes(e.level) &&
      !access.entries.some(v => v.domain === domain && v.grant_id === e.grant_id && v.level === "view")),
  );
}

/** The server already Cedar-checked ENFORCED rows; prepared or expired grants never open a form. */
export function accessRefusal(access: AccessEffective, need: AccessRequirement, served: readonly ServedCapability[] = []): "scope_tenant_wide_only" | "access_denied" | "out_of_scope" | null {
  if ("servedCapability" in need) return served.includes(need.servedCapability) ? null : "access_denied";
  // Hubs compose their served destination requirements, never a second list of grants.
  if ("destinations" in need) return need.destinations.some(requirement => accessRefusal(access, requirement, served) === null) ? null : "access_denied";
  if ("allOf" in need) return need.allOf.length ? need.allOf.map(requirement => accessRefusal(access, requirement)).find(code => code !== null) ?? null : "access_denied";
  if ("action" in need) return access.decisions?.[need.action] === true ? null : "access_denied";
  if (access.is_ops) return null;
  const { domain, level, tenant, scopes } = need;
  const held = enforcedRows(access, domain, level);
  if (held.some(e => (!tenant || e.scope.kind === "TENANT") && (!scopes || scopes.includes(e.scope.kind)))) return null;
  return held.length ? tenant ? "scope_tenant_wide_only" : "out_of_scope" : "access_denied";
}
