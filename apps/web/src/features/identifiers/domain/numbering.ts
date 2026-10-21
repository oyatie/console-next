// Rules the identifier screens follow before asking the server, so a disabled button always names why. The server
// checks every one of them again (422/409); these only keep a request that cannot pass from being sent.
import type { components } from "@console/api/schema";

type NumberRule = components["schemas"]["EmployeeNumberRule"];
type ScopeKind = NumberRule["scope_kind"];

/** A numbering scope: the tenant, one legal entity, or one workplace (most specific wins at numbering). */
export type Scope = { kind: ScopeKind; id?: string; label: string };
type Entity = { id: string; name: string; workplaces: { id: string; name: string }[] };

/** Every scope a rule can be set on, tenant first, each legal entity followed by its workplaces. */
export const scopes = (tenant: string, entities: readonly Entity[]): Scope[] => [
  { kind: "TENANT", label: tenant },
  ...entities.flatMap((e) => [{ kind: "LEGAL_ENTITY" as const, id: e.id, label: e.name }, ...e.workplaces.map((w) => ({ kind: "WORKPLACE" as const, id: w.id, label: `${e.name} · ${w.name}` }))]),
];
export const scopeKey = (s: { kind: ScopeKind; id?: string | null }) => (s.kind === "TENANT" ? "TENANT" : `${s.kind}:${s.id}`);
export const ruleOf = (rules: readonly NumberRule[], s: Scope) => rules.find((r) => scopeKey({ kind: r.scope_kind, id: r.scope_id }) === scopeKey(s));

/** EmployeeNumberRuleRequest: a prefix of letters, digits, - and _ (up to 16), and a width of 1 to 12 digits. */
export const PREFIX = /^[A-Za-z0-9_-]{0,16}$/;
export const WIDTH = { min: 1, max: 12 } as const;
export type RuleProblem = "prefix" | "width";
export const ruleProblem = (prefix: string, width: number): RuleProblem | null =>
  !PREFIX.test(prefix) ? "prefix" : !Number.isInteger(width) || width < WIDTH.min || width > WIDTH.max ? "width" : null;
/** What the first number under a prefix and width looks like (a preview; the server says the real next one). */
export const sample = (prefix: string, width: number) => `${prefix}${"1".padStart(Math.max(1, Math.min(width, WIDTH.max)), "0")}`;

/** A number change: a number, not the current one, effective today or earlier, with a reason (and a note for Other). */
export type ChangeProblem = "number" | "unchanged" | "date" | "future" | "reason" | "note";
export function changeProblem(c: { current: string | null; next: string; date: string; today: string; reason: string | null; needsNote: boolean; note: string }): ChangeProblem | null {
  const next = c.next.trim();
  if (!next) return "number";
  if (next === c.current) return "unchanged";
  if (!c.date) return "date";
  if (c.date > c.today) return "future";
  if (!c.reason) return "reason";
  if (c.needsNote && !c.note.trim()) return "note";
  return null;
}
