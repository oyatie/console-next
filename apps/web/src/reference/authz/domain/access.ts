// SPDX-License-Identifier: LicenseRef-Proprietary
import type { AccessEffective } from "../api";

export type Requirement = { domain: AccessEffective["entries"][number]["domain"]; level: AccessEffective["entries"][number]["level"]; tenant?: boolean };

/** The server already Cedar-checked ENFORCED rows; prepared or expired grants never open a form. */
export function accessRefusal(access: AccessEffective, { domain, level, tenant }: Requirement) {
  if (access.is_ops) return null;
  const held = access.entries.filter(e => e.domain === domain && e.level === level && e.enforcement === "ENFORCED");
  if (held.some(e => !tenant || e.scope.kind === "TENANT")) return null;
  return tenant && held.length ? "scope_tenant_wide_only" : "access_denied";
}
