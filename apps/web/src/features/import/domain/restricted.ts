// SPDX-License-Identifier: LicenseRef-Proprietary
// Mirrors backend `classification.rs` and `pii.rs` restricted-header rules so column mapping filters disallowed targets client-side.
import rules from "../../../../../../packages/i18n/src/catalogs/import-restricted-headers.json" with { type: "json" };

type RestrictedKind = "rrn" | "phone" | "unmapped";

function normalizeHeaderLabel(raw: string): string {
  return raw.replace(/\s+/g, "");
}

function importHeaderMatchKey(header: string): string {
  return normalizeHeaderLabel(header)
    .replace(/[()[\]{}_\-/\\.·:]/g, "")
    .toLowerCase();
}

const rrnKeys = new Set(rules.rrnAliases.map(importHeaderMatchKey));
const phoneKeys = new Set(rules.phoneAliases.map(importHeaderMatchKey));
const dobKeys = new Set(rules.canonicalDobAliases.map(importHeaderMatchKey));
const worksiteAddressKeys = new Set(rules.locationWorksiteAddressAliases.map(importHeaderMatchKey));

export function isPii2RestrictedHeader(header: string): boolean {
  const lower = header.toLowerCase();
  const matchKey = importHeaderMatchKey(header);
  const hasWorkQualifier =
    rules.workQualifiersKo.some((q) => matchKey.includes(q)) ||
    rules.workQualifiersEn.some((q) => matchKey.includes(q));
  const restrictedAddr =
    matchKey === rules.pii2AddrFragmentKo ||
    ((header.includes(rules.pii2AddrFragmentKo) || matchKey.includes(rules.pii2AddrFragmentKo)) && !hasWorkQualifier);
  return (
    restrictedAddr ||
    header.includes(rules.pii2DobFragmentKo) ||
    matchKey.includes(rules.pii2DobFragmentKo) ||
    rules.restrictedFragmentsEn.some((fragment) => lower.includes(fragment) || matchKey.includes(fragment))
  );
}

function isRestrictedEmployeeImportHeader(header: string): boolean {
  const matchKey = importHeaderMatchKey(header);
  return (
    rules.restrictedFragmentsKo.some((fragment) => header.includes(fragment) || matchKey.includes(fragment)) ||
    isPii2RestrictedHeader(header)
  );
}

export function allowedRestrictedTarget(header: string): "rrn" | "phone" | null {
  const key = importHeaderMatchKey(header);
  if (key === "rrn" || rrnKeys.has(key)) return "rrn";
  if (key === "phone" || phoneKeys.has(key)) return "phone";
  return null;
}

export function isDroppedEmployeeImportHeader(header: string): boolean {
  const key = importHeaderMatchKey(header);
  if (allowedRestrictedTarget(header) !== null) return true;
  if (dobKeys.has(key) || worksiteAddressKeys.has(key)) return false;
  return isRestrictedEmployeeImportHeader(header);
}

export function restrictedKind(header: string): RestrictedKind | null {
  if (!isDroppedEmployeeImportHeader(header)) return null;
  return allowedRestrictedTarget(header) ?? "unmapped";
}

export function isAllowedTargetForHeader(header: string, target: string | null): boolean {
  if (target == null || target === "") return true;
  const kind = restrictedKind(header);
  if (kind === null) return true;
  if (kind === "unmapped") return false;
  return target === kind;
}

export function allowedTargetsForHeader(header: string, availableTargets: readonly string[], currentTarget?: string | null): string[] {
  const kind = restrictedKind(header);
  if (kind === null) return [...availableTargets];
  if (kind === "unmapped") return [];
  if (availableTargets.includes(kind) || currentTarget === kind) return [kind];
  return [];
}
