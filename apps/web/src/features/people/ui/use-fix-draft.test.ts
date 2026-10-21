import { expect, test } from "vitest";
import { currentOf, draftText, toChange } from "./use-fix-draft";
import type { Card } from "./use-card";

const c = {
  e: { name: "Employee", position: "Staff" },
  d: { classification: { grade_id: "g1", job_title_id: "t1", position_kind_id: "p1", job_family_id: "f1" } },
  register: {},
  title: (id: string) => ({ g1: "Grade 1", g2: "Grade 2", t1: "Staff", t2: "Senior", p1: "Team lead", p2: "Director", f1: "Engineering", f2: "Operations" })[id as "g1"],
} as unknown as Card;

test("catalog corrections carry ids and show catalog labels, never the position for every field", () => {
  for (const [field, key, old, next, label] of [
    ["grade", "grade_id", "g1", "g2", "Grade 2"],
    ["position", "job_title_id", "t1", "t2", "Senior"],
    ["title", "position_kind_id", "p1", "p2", "Director"],
    ["family", "job_family_id", "f1", "f2", "Operations"],
  ] as const) {
    expect(currentOf(c, field).raw).toBe(old);
    expect(toChange(field, next, c)).toEqual({ [key]: next });
    expect(toChange(field, old, c)).toBeNull();
    expect(draftText(field, next, c)).toBe(label);
  }
});
