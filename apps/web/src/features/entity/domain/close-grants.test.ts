import { describe, expect, it } from "vitest";
import { closingGrants, endOps } from "./close-grants";

const g = (id: string, kind: "TENANT" | "LEGAL_ENTITY" | "WORKPLACE" | "DEPARTMENT", node: string | null) =>
  ({ id, scope: { kind, node_id: node, include_descendants: true } }) as never;

describe("closingGrants", () => {
  const all = [g("t", "TENANT", null), g("e", "LEGAL_ENTITY", "E1"), g("o", "LEGAL_ENTITY", "E2"), g("w", "WORKPLACE", "W1"), g("x", "WORKPLACE", "W9"), g("d", "DEPARTMENT", "W1")];
  it("takes the entity's own and its workplaces' grants only", () => {
    expect(closingGrants(all, "E1", ["W1", "W2"]).map((x: { id: string }) => x.id)).toEqual(["e", "w"]);
  });
  it("never ends a tenant-wide or another entity's grant", () => {
    expect(closingGrants(all, "E3", [])).toEqual([]);
  });
  it("revokes each one", () => {
    expect(endOps([g("e", "LEGAL_ENTITY", "E1")])).toEqual([{ op: "revoke", grant_id: "e" }]);
  });
});
