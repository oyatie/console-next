// Labels for the access screens: domains, levels, reasons and states by catalog id (never the server key), one-line role
// summaries, and the scope as every consequence names it.
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { codeText } from "../../lib/labels";
import { personLabel, type PersonIdentity } from "../../reference/person/present";
import { domainText, levelText } from "../../reference/authz/present";
export { domainText, levelText };
import { lastDay } from "./domain/grants";
import { find, reach, type OrgNode, type Scope } from "./domain/scope";
import type { AccessGrant, AccessRoleLine, AccessScope, Account, PreviewItem } from "./api";

export const domainHelp = (key: string) => codeText(`accessCodes.domain.${key}.help`, "");
export const enforcementText = (e: string) => codeText(`accessCodes.enforcement.${e}`, e);
/** Only a server-scheduled preview carries an activation time. */
export const scheduledText = (item: Pick<PreviewItem, "enforcement_after" | "activates_at">) =>
  item.enforcement_after === "SCHEDULED" && item.activates_at
    ? t("access.grant.scheduled", { at: fmtDateTime(item.activates_at) }) : null;
/** A saved scheduled grant keeps its server deadline visible in the receipt. */
export const grantDoneText = (name: string, grants: readonly AccessGrant[]) => {
  const at = grants.find((g) => g.enforcement === "SCHEDULED" && g.activates_at)?.activates_at;
  return t(at ? "access.grant.done.scheduled" : "access.grant.done", { name, count: grants.length, at: at ? fmtDateTime(at) : "" });
};
/** Why the server refused one operation of a batch, by its code; an unknown code falls back to the server's own words. */
export const refusalText = (r: { code: string; message: string } | null | undefined) => (r ? codeText(`accessCodes.refusal.${r.code}`, r.message) : t("access.refused"));

/** "HR records create & edit, org view": each line by the levels beyond view (view alone when it is the only one). */
export const linesText = (lines: readonly AccessRoleLine[]) =>
  lines.map((l) => `${domainText(l.domain)} ${l.levels.filter((v) => v !== "view" || l.levels.length === 1).map(levelText).join("·")}`).join(" · ");

/** "<entity> and below, n people" or "whole company, n people" for a scope being chosen (the count is today's headcount). */
export function scopeLabel(roots: readonly OrgNode[], v: Scope) {
  const n = reach(roots, v) ?? 0;
  if (v.kind === "TENANT") return t("access.scope.tenant.label", { count: n });
  const name = (v.node_id && find(roots, v.node_id)?.node.name) || "";
  return t(v.include_descendants ? "access.scope.below.label" : "access.scope.only.label", { name, count: n });
}

/** A stored scope by its name: the one the server sends with it, else the tree's (a list read may omit it). */
export const storedScope = (s: AccessScope, roots: readonly OrgNode[] = []) =>
  s.kind === "TENANT"
    ? t("access.scope.tenant")
    : t(s.include_descendants ? "access.scope.below.short" : "access.scope.only.short", { name: s.node_name || (s.node_id && find(roots, s.node_id)?.node.name) || "" });

/** A stored scope with today's headcount when the tree still holds its node (name, "and below", today's count). */
export const scopeText = (roots: readonly OrgNode[], s: AccessScope) => (reach(roots, s) == null ? storedScope(s, roots) : scopeLabel(roots, s));

/** "go-live ~ last day" for a grant waiting for go-live, else its first day; an open end reads "from ...". */
export function periodText(g: { valid_from: string; valid_to?: string | null; activates_at?: string | null; enforcement: string }) {
  const from = g.enforcement === "PREPARED" ? t("access.period.golive") : g.enforcement === "SCHEDULED" && g.activates_at ? fmtDateTime(g.activates_at) : fmtDate(g.valid_from);
  const to = lastDay(g.valid_to);
  return to ? t("access.period", { from, to: fmtDate(to) }) : t("access.period.open", { from });
}

/** "until <date>" or "no end date" from an exclusive wire end. */
export const untilText = (validTo: string | null | undefined) => {
  const d = lastDay(validTo);
  return d ? t("access.until", { date: fmtDate(d) }) : t("access.until.none");
};

export const accountLabel = (a: PersonIdentity | undefined, fallback: string, peers: readonly PersonIdentity[] = []) =>
  personLabel(a ?? { id: fallback }, peers).text;

/** Join current account facts onto a grant; retain its snapshot when the account is unavailable. */
export const grantPerson = (g: AccessGrant, accounts: readonly Account[]): PersonIdentity =>
  accounts.find((a) => a.id === g.account_id) ?? { id: g.account_id, display_name: g.account_display_name, employee_number: g.account_employee_number, org_unit: g.account_unit };
