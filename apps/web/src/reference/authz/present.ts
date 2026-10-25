// What an account may do, in words every screen shares (governance-22): one line per grant — role · scope · until —
// with its levels and the server's caveats. My access, the person-access view and the refused state all read it.
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { codeText } from "../../lib/labels";
import { todayKst } from "../../lib/pure/today";
import type { AccessEffectiveEntry } from "./api";

type Node = { id: string; name: string; children?: readonly Node[] };
const ORDER = ["view", "edit", "approve", "export"];

const nameOf = (nodes: readonly Node[], id: string | null | undefined): string | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n.name;
    const below = nameOf(n.children ?? [], id);
    if (below) return below;
  }
  return undefined;
};

/** A grant's scope by its stored name, then the org tree, else its kind ("entity scope"). */
export const scopeName = (s: AccessEffectiveEntry["scope"], roots: readonly Node[] = []) => {
  if (s.kind === "TENANT") return t("access.scope.tenant");
  const name = s.node_name || nameOf(roots, s.node_id);
  return name ? t(s.include_descendants === false ? "access.scope.only.short" : "access.scope.below.short", { name }) : t(`denied.scopeKind.${s.kind}`);
};

/** The last day an exclusive end still counts, or no end. */
export const untilText = (to: string | null | undefined) =>
  to ? t("access.until", { date: fmtDate(todayKst(new Date(Date.parse(to) - 1))) }) : t("access.until.none");

type GrantLine = { id: string; role: string; scope: string; until: string; state?: string; reach: string; caveats: string[] };

/** One line per grant, in the order the server sent them; a state is named only when the grant is not in force. */
export function grantLines(entries: readonly AccessEffectiveEntry[], roots: readonly Node[] = []): GrantLine[] {
  return [...new Set(entries.map((e) => e.grant_id))].map((id) => {
    const rows = entries.filter((e) => e.grant_id === id);
    const g = rows[0]!;
    const domains = [...new Set(rows.map((r) => r.domain))];
    return {
      id,
      role: g.role_name_ko,
      scope: scopeName(g.scope, roots),
      until: untilText(g.valid_to),
      state: g.enforcement === "ENFORCED" ? undefined : codeText(`accessCodes.enforcement.${g.enforcement}`, g.enforcement),
      reach: domains
        .map((d) => `${codeText(`accessCodes.domain.${d}`, d)} ${ORDER.filter((l) => rows.some((r) => r.domain === d && r.level === l)).map((l) => codeText(`accessCodes.level.${l}`, l)).join("·")}`)
        .join(" · "),
      caveats: [...new Set(rows.flatMap((r) => r.caveats ?? []))].map((c) => codeText(`accessCodes.caveat.${c}`, c)),
    };
  });
}

/** A grant refusal in the access screens' words; undefined for any other code (the shared refusal text). */
export const grantRefusal = (code: string) => {
  const id = `accessCodes.refusal.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

export const domainText = (key: string) => codeText(`accessCodes.domain.${key}`, key);
export const levelText = (level: components["schemas"]["AccessLevel"]) => t(`accessCodes.level.${level}`);
