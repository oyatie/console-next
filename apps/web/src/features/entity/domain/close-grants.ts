// The grants a close ends with it (access-model §5.2, UX-R3 company-13/14): those scoped to the closing legal entity or to
// one of its workplaces. Department-scoped grants end with their department's dissolution, which the close requires first.
import type { components } from "@console/api/schema";

type Grant = components["schemas"]["AccessGrant"];
type GrantOp = components["schemas"]["AccessGrantOperation"];

/** Live grants whose scope is the entity itself or one of `workplaces`. */
export const closingGrants = (grants: readonly Grant[], entity: string, workplaces: readonly string[]) =>
  grants.filter((g) => (g.scope.kind === "LEGAL_ENTITY" && g.scope.node_id === entity) || (g.scope.kind === "WORKPLACE" && workplaces.includes(g.scope.node_id ?? "")));

/** The close dates no later than today, so each grant is revoked (a new end before now is refused). */
export const endOps = (grants: readonly Grant[]): GrantOp[] => grants.map((g) => ({ op: "revoke", grant_id: g.id }));
