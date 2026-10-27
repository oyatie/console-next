// SPDX-License-Identifier: LicenseRef-Proprietary
import type { AccessEffective } from "../api";

export type Requirement = { domain: AccessEffective["entries"][number]["domain"]; level: AccessEffective["entries"][number]["level"]; tenant?: boolean; scopes?: readonly AccessEffective["entries"][number]["scope"]["kind"][] };
export type AccessRequirement = Requirement | { allOf: readonly Requirement[] } | { destinations: readonly AccessRequirement[] };

/** The server already Cedar-checked ENFORCED rows; prepared or expired grants never open a form. */
export function accessRefusal(access: AccessEffective, need: AccessRequirement): "scope_tenant_wide_only" | "access_denied" | "out_of_scope" | null {
  // Hubs compose their served destination requirements, never a second list of grants.
  if ("destinations" in need) return need.destinations.some(requirement => accessRefusal(access, requirement) === null) ? null : "access_denied";
  if (access.is_ops) return null;
  if ("allOf" in need) return need.allOf.length ? need.allOf.map(requirement => accessRefusal(access, requirement)).find(code => code !== null) ?? null : "access_denied";
  const { domain, level, tenant, scopes } = need;
  // Normalized responses include view; never override a Cedar-refused view row from the same grant.
  const held = access.entries.filter(e =>
    e.domain === domain && e.enforcement === "ENFORCED" &&
    (e.level === level || level === "view" && ["edit", "approve", "export"].includes(e.level) &&
      !access.entries.some(v => v.domain === domain && v.grant_id === e.grant_id && v.level === "view")),
  );
  if (held.some(e => (!tenant || e.scope.kind === "TENANT") && (!scopes || scopes.includes(e.scope.kind)))) return null;
  return held.length ? tenant ? "scope_tenant_wide_only" : "out_of_scope" : "access_denied";
}
