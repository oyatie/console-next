import { describe, expect, it } from "vitest";
import { changeProblem, ruleOf, ruleProblem, sample, scopeKey, scopes } from "./numbering";

describe("numbering", () => {
  const ents = [{ id: "e1", name: "가람", workplaces: [{ id: "w1", name: "본점" }] }, { id: "e2", name: "누리", workplaces: [] }];
  it("lists the tenant, then each legal entity followed by its workplaces", () => {
    expect(scopes("회사", ents).map(scopeKey)).toEqual(["TENANT", "LEGAL_ENTITY:e1", "WORKPLACE:w1", "LEGAL_ENTITY:e2"]);
    expect(scopes("회사", ents)[2]!.label).toBe("가람 · 본점");
    const rules = [{ scope_kind: "WORKPLACE" as const, scope_id: "w1", prefix: "GR-", width: 4, next_number: "GR-0001" }];
    expect(ruleOf(rules, scopes("회사", ents)[2]!)?.next_number).toBe("GR-0001");
    expect(ruleOf(rules, scopes("회사", ents)[0]!)).toBeUndefined();
  });

  it("takes the prefixes and widths the server takes, and shows the first number", () => {
    expect(ruleProblem("GR-", 4)).toBeNull();
    expect(ruleProblem("", 1)).toBeNull();
    expect(ruleProblem("가람", 4)).toBe("prefix");
    expect(ruleProblem("A".repeat(17), 4)).toBe("prefix");
    expect(ruleProblem("A", 0)).toBe("width");
    expect(ruleProblem("A", 13)).toBe("width");
    expect(sample("GR-", 4)).toBe("GR-0001");
  });

  it("a change needs a different number, a date not ahead of today and a reason (with a note for Other)", () => {
    const base = { current: "A-1", next: "B-1", date: "2026-10-06", today: "2026-10-06", reason: "INPUT_ERROR", needsNote: false, note: "" };
    expect(changeProblem(base)).toBeNull();
    expect(changeProblem({ ...base, next: " " })).toBe("number");
    expect(changeProblem({ ...base, next: "A-1" })).toBe("unchanged");
    expect(changeProblem({ ...base, date: "" })).toBe("date");
    expect(changeProblem({ ...base, date: "2026-10-07" })).toBe("future");
    expect(changeProblem({ ...base, reason: null })).toBe("reason");
    expect(changeProblem({ ...base, needsNote: true })).toBe("note");
    expect(changeProblem({ ...base, current: null })).toBeNull();
  });
});
